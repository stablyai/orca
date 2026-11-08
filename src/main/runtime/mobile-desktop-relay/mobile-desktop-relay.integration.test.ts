import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { GITHUB_REPO_WORK_ITEM_METHODS } from '../rpc/methods/source-control/github/github-repo-work-item-methods'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../shared/github/work-item-target'
import { GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY } from '../../../shared/task-source-runtime-capabilities'
import { randomUUID } from 'node:crypto'
import { publishHostDescriptor } from '../hosts/platform-probe/host-descriptor'
import { GITHUB_ISSUE_METHODS } from '../rpc/methods/source-control/github/github-issue-methods'
import { classifyExactGitHubOperation } from '../../../shared/github/exact-work-item-operation'
import '../rpc/unused-default-rpc-methods.test-fixture'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../shared/delegated-mobile-device-contract'
import { decodeTerminalStreamFrame } from '../../../shared/terminal/stream/terminal-stream-protocol'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime/remote-runtime-client'

import { OrcaRuntimeService } from '../orca-runtime'

import { readRuntimeMetadata } from '../rpc/server/runtime-metadata'
import { OrcaRuntimeRpcServer } from '../rpc/server/runtime-rpc'
import { ORCHESTRATION_CALLER_METHODS } from '../rpc/methods/orchestration/caller-show'
import { MOBILE_RPC_METHOD_ROUTES } from '../rpc/server/runtime-rpc-mobile-method-routing'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../rpc/server/runtime-rpc-mobile-method-allowlist'
import { STATUS_METHODS } from '../rpc/methods/host-management/status'
import { TERMINAL_METHODS } from '../rpc/methods/terminal/terminal'
import { BROWSER_CORE_METHODS } from '../rpc/methods/browser/browser-core'
import { BROWSER_SCREENCAST_METHODS } from '../rpc/methods/browser/browser-screencast'
import { SSH_METHODS } from '../rpc/methods/ssh/ssh'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from '../rpc/methods/client-events/runtime-client-capabilities'
import { WORKTREE_METHODS } from '../rpc/methods/workspaces/worktree'
import { CLIENT_UI_METHODS } from '../rpc/methods/client-state/client-ui'
import { PAIRING_METHODS } from '../rpc/methods/pairing/pairing'
import { sendRequest } from '../rpc/server/runtime-rpc-test-harness'
import { makeStore } from '../rpc/server/runtime-rpc-worktree-store-fixtures'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import type * as PassthroughSocketModule from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import { connectPhone, pair, TARGET, type Frame } from './mobile-desktop-relay-phone.test-fixture'

const passthroughOpens = vi.hoisted(() => {
  const hostReplies: string[] = []
  const heldOpen: (() => void)[] = []
  const heldStatus: (() => void)[] = []
  return {
    count: 0,
    hostReplies,
    holdStatus: false,
    holdOpen: false,
    heldOpen,
    heldStatus
  }
})
vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: (await getWorktreeOwnerMocks()).listWorktrees
}))

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: (await getWorktreeOwnerMocks()).listWorktreesStrict
}))

vi.mock(
  '../../../shared/remote-runtime/remote-runtime-passthrough-socket',
  async (importOriginal) => {
    const original = await importOriginal<typeof PassthroughSocketModule>()
    return {
      ...original,
      openRemoteRuntimePassthroughSocket: (
        ...[pairing, capabilities, callbacks, options]: Parameters<
          typeof original.openRemoteRuntimePassthroughSocket
        >
      ) => {
        passthroughOpens.count += 1
        const opening = original.openRemoteRuntimePassthroughSocket(
          pairing,
          capabilities,
          {
            ...callbacks,
            onText: (plaintext) => {
              passthroughOpens.hostReplies.push(plaintext)
              if (passthroughOpens.holdStatus && plaintext.includes('relay-github-authority:')) {
                passthroughOpens.heldStatus.push(() => callbacks.onText(plaintext))
              } else {
                callbacks.onText(plaintext)
              }
            }
          },
          options
        )
        return opening.then(async (socket) => {
          if (passthroughOpens.holdOpen) {
            await new Promise<void>((resolve) => passthroughOpens.heldOpen.push(resolve))
          }
          return socket
        })
      }
    }
  }
)

const { getWorktreeOwnerMocks } = vi.hoisted(() => {
  function createWorktreeOwnerMocks() {
    return (async () =>
      (
        await import('../rpc/server/runtime-rpc-worktree-store-fixtures')
      ).createWorktreeListingMocks())()
  }
  let fixture: ReturnType<typeof createWorktreeOwnerMocks> | undefined
  return { getWorktreeOwnerMocks: () => (fixture ??= createWorktreeOwnerMocks()) }
})

class SeatObservableRuntime extends OrcaRuntimeService {
  seatClientIds(ptyId: string): string[] {
    return [...(this.mobileSubscribers.get(ptyId)?.keys() ?? [])]
  }
}

const WORKTREE = 'id:repo-1::/tmp/worktree-a'

describe('mobile desktop relay: phone -> desktop -> server', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    passthroughOpens.holdStatus = false
    passthroughOpens.holdOpen = false
    for (const release of passthroughOpens.heldOpen.splice(0)) {
      release()
    }
    for (const release of passthroughOpens.heldStatus.splice(0)) {
      release()
    }
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function startRuntime(spawnedOnThisHost: string[] = [], locator = true) {
    const writes: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store carries the surface these RPCs read, as in the sibling streaming tests.
    const runtime = new SeatObservableRuntime(makeStore() as never)
    runtime.setPtyController({
      spawn: vi.fn().mockImplementation(async () => {
        spawnedOnThisHost.push('pty-shared')
        return { id: 'pty-shared' }
      }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      resize: () => true,
      getSize: () => ({ cols: 80, rows: 24 })
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-'))
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      methods: [
        ...STATUS_METHODS,
        ...GITHUB_ISSUE_METHODS,
        ...GITHUB_REPO_WORK_ITEM_METHODS,
        ...(locator ? ORCHESTRATION_CALLER_METHODS : []),
        ...TERMINAL_METHODS,
        ...BROWSER_CORE_METHODS,
        ...BROWSER_SCREENCAST_METHODS,
        ...SSH_METHODS,
        ...RUNTIME_CLIENT_CAPABILITY_METHODS,
        ...CLIENT_UI_METHODS,
        ...WORKTREE_METHODS,
        ...PAIRING_METHODS
      ],
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    publishHostDescriptor(runtime.getRuntimeId(), { installationId: randomUUID() })
    cleanups.push(() => publishHostDescriptor(runtime.getRuntimeId(), null))
    cleanups.push(() => server.stop())
    return { server, runtime, writes, userDataPath }
  }

  async function startTopology(locator = true) {
    const host = await startRuntime([], locator)
    const desktopSpawns: string[] = []
    const desktop = await startRuntime(desktopSpawns)
    const desktopOnHost = pair(host.server, 'runtime', 'MacBook')
    const registry = host.server.getDeviceRegistry()!
    const children = () => registry.listDelegatedMobileDevices(desktopOnHost.pairedDeviceId!)
    const syncedNames: string[][] = []
    const retirementListeners = new Set<(environmentId: string) => void>()
    const state = {
      pairing: desktopOnHost,
      capable: true,
      hostedPages: new Set<string>(),
      retire: (environmentId: string) =>
        retirementListeners.forEach((listener) => listener(environmentId))
    }
    const hosts: MobileDesktopRelayHosts = {
      list: () => ({
        environments: [],
        statusByEnvironmentId: new Map(),
        sshTargetLabels: new Map(),
        sshConnectionStates: new Map()
      }),
      resolve: async (environmentId) =>
        environmentId === 'env-1'
          ? { environmentId, fence: state.pairing.endpoint, pairing: state.pairing }
          : null,
      call: async (_host, method, params) => {
        if (method === DELEGATED_MOBILE_DEVICE_SYNC_METHOD) {
          const { phones } = DelegatedMobileDeviceSyncParamsSchema.parse(params)
          syncedNames.push(phones.map((phone) => phone.name))
        }
        const response = await sendRemoteRuntimeRequest(
          pairedRuntimeConnectionFromOffer(state.pairing),
          method,
          params,
          5_000
        )
        return method === 'status.get' && !state.capable && response.ok
          ? {
              ...response,
              result: { ...z.object({}).passthrough().parse(response.result), capabilities: [] }
            }
          : response
      },
      hostsBrowserPage: (environmentId, browserPageId) =>
        environmentId === 'env-1' && state.hostedPages.has(browserPageId),
      onEnvironmentRetired: (listener) => {
        retirementListeners.add(listener)
        return () => retirementListeners.delete(listener)
      },
      onStatusChanged: () => () => {},
      watchChanges: () => ({ close: () => {}, current: () => true })
    }
    desktop.server.setMobileDesktopRelayHosts(hosts)
    const metadata = readRuntimeMetadata(host.userDataPath)!
    const created = await sendRequest(metadata.transports[0]!.endpoint, {
      id: 'create',
      authToken: metadata.authToken,
      method: 'terminal.create',
      params: {
        worktree: WORKTREE,
        command: 'bash',
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        activate: true
      }
    })
    const handle = z.object({ terminal: z.object({ handle: z.string() }) }).parse(created.result)
      .terminal.handle
    return { host, desktop, desktopSpawns, children, syncedNames, state, handle }
  }

  type Phone = Awaited<ReturnType<typeof connectPhone>>

  it('admits a proven phone locator on the configured delegated target, never the relay owner', async () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('orchestration.partyLocation')).toBe('execution-host')
    const { host, desktop, handle } = await startTopology()
    const phone = await connectPhone(desktop.server, 'sender-open', cleanups)
    const atHost = vi.spyOn(host.runtime, 'getTerminalPaneKey')
    const atDesktop = vi.spyOn(desktop.runtime, 'getTerminalPaneKey')
    phone.send('locate', 'orchestration.partyLocation', { address: handle, messageIds: [] })
    expect(await phone.next('locate')).toMatchObject({
      ok: true,
      result: { location: { kind: 'terminal', handle } }
    })
    expect(atHost).toHaveBeenCalledWith(handle)
    expect(atDesktop).not.toHaveBeenCalled()
    phone.send('forged', 'orchestration.partyLocation', { address: handle, callerScope: 'owner' })
    expect(await phone.next('forged')).toMatchObject({
      ok: true,
      result: { location: { kind: 'terminal', handle } }
    })
    phone.send('unlisted', 'orchestration.callerShow', {}, TARGET, undefined, {
      callerScope: 'owner',
      clientKind: 'runtime'
    })
    expect(await phone.next('unlisted')).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    phone.send(
      'unknown-target',
      'orchestration.partyLocation',
      { address: handle },
      'runtime:not-configured'
    )
    expect(await phone.next('unknown-target')).toMatchObject({ ok: false })
    expect(atDesktop).not.toHaveBeenCalled()
    // Historical hops refuse before forwarding; do not substitute the relay's local authority.
    MOBILE_RPC_METHOD_ALLOWLIST.delete('orchestration.partyLocation')
    try {
      phone.send('old-hop', 'orchestration.partyLocation', { address: handle })
      expect(await phone.next('old-hop')).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    } finally {
      MOBILE_RPC_METHOD_ALLOWLIST.add('orchestration.partyLocation')
    }
    expect(atHost).toHaveBeenCalledTimes(2)
  })

  async function subscribe(phone: Phone, handle: string, id = 'sub') {
    phone.send(id, 'terminal.subscribe', {
      terminal: handle,
      client: { id: phone.token, type: 'mobile' },
      viewport: { cols: 40, rows: 20 },
      capabilities: { terminalBinaryStream: 1 }
    })
    const subscribed = await phone.next(
      id,
      (frame) =>
        z.object({ result: z.object({ type: z.literal('subscribed') }) }).safeParse(frame).success
    )
    return z.object({ result: z.object({ streamId: z.number() }) }).parse(subscribed).result
      .streamId
  }

  const isOk = (frame: Frame) => frame.ok === true
  const errorCode = (frame: Frame) =>
    z.object({ error: z.object({ code: z.string() }) }).parse(frame).error.code
  const sendAccepted = (frame: Frame) =>
    z.object({ result: z.object({ send: z.object({ accepted: z.boolean() }) }) }).parse(frame)
      .result.send.accepted

  it('relays a terminal subscribe, its binary stream, input and a query reply as the phone delegated device', async () => {
    const { host, desktop, children, syncedNames, handle } = await startTopology()
    // Never re-relay a phone another desktop relayed here.
    const registry = desktop.server.getDeviceRegistry()!
    const otherDesktop = registry.getDevice(
      pair(desktop.server, 'runtime', 'Other Mac').pairedDeviceId!
    )!
    registry.upsertDelegatedMobileDevices(otherDesktop, [
      { phoneKey: 'p', name: 'iPad via Other Mac' }
    ])
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)

    const streamId = await subscribe(phone, handle)
    const hostStreamId = z
      .object({
        id: z.literal('sub'),
        result: z.object({ type: z.literal('subscribed'), streamId: z.number() })
      })
      .parse(
        passthroughOpens.hostReplies
          .map((frame) => JSON.parse(frame))
          .find((frame) => frame.id === 'sub' && frame.result?.type === 'subscribed')
      ).result.streamId
    expect(streamId).not.toBe(hostStreamId)
    await vi.waitFor(() =>
      expect(
        phone.binaries.some((bytes) => decodeTerminalStreamFrame(bytes)?.streamId === streamId)
      ).toBe(true)
    )
    expect(
      phone.binaries.some((bytes) => decodeTerminalStreamFrame(bytes)?.streamId === hostStreamId)
    ).toBe(false)
    expect(syncedNames).toEqual([[`iPhone via ${desktop.runtime.readMachineName()}`]])
    const delegated = children()[0]!
    // Seat the delegated phone, never the desktop token.
    expect(host.runtime.seatClientIds('pty-shared')).toEqual([delegated.token])

    phone.send('in', 'terminal.send', {
      terminal: handle,
      text: 'ls',
      client: { id: phone.token, type: 'mobile' }
    })
    expect(isOk(await phone.next('in'))).toBe(true)
    expect(host.writes).toContain('ls')
    // terminal.send cross-checks client.id against socket identity; only the delegated token passes.
    phone.send('query', 'terminal.send', {
      terminal: handle,
      text: '\x1b[0n',
      enter: false,
      inputKind: 'query-reply',
      client: { id: phone.token, type: 'mobile' }
    })
    expect(sendAccepted(await phone.next('query'))).toBe(true)
    expect(host.writes).toContain('\x1b[0n')
  })

  it('stops relaying a phone the server revoked until the next sync', async () => {
    const { host, desktop, children, state, handle } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    await subscribe(phone, handle)
    const revoked = children()[0]!

    await host.server.revokeMobileDevice(revoked.deviceId)
    expect(errorCode(await phone.next('sub', (frame) => frame.ok === false))).toBe(
      'remote_runtime_unavailable'
    )
    const opensBefore = passthroughOpens.count
    phone.send('after-1', 'terminal.list', {})
    expect(errorCode(await phone.next('after-1'))).toBe('remote_runtime_unavailable')
    phone.send('after-2', 'terminal.list', {})
    expect(errorCode(await phone.next('after-2'))).toBe('remote_runtime_unavailable')
    expect(passthroughOpens.count - opensBefore).toBe(1)

    state.retire('env-1')
    phone.send('after-sync', 'terminal.list', {})
    expect(isOk(await phone.next('after-sync'))).toBe(true)
  })

  it('refuses binary-frame methods and unknown servers without running anything on the desktop', async () => {
    const { desktop, desktopSpawns } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)

    phone.send('multiplex', 'terminal.multiplex', {})
    expect(errorCode(await phone.next('multiplex'))).toBe('forbidden')
    const create = {
      worktree: WORKTREE,
      command: 'bash',
      tabId: 'tab-2',
      leafId: '22222222-2222-4222-8222-222222222222'
    }
    phone.send('unknown', 'terminal.create', create, 'runtime:env-unknown')
    expect(errorCode(await phone.next('unknown'))).toBe('remote_runtime_unavailable')
    phone.send('garbled', 'terminal.create', create, 'runtime:')
    expect(errorCode(await phone.next('garbled'))).toBe('invalid_argument')
    expect(desktopSpawns).toEqual([])
    const opensBefore = passthroughOpens.count
    phone.send('absent', 'terminal.list', {}, null)
    phone.send('local', 'terminal.list', {}, 'local')
    phone.send('ssh', 'terminal.list', {}, 'ssh:devbox')
    for (const id of ['absent', 'local', 'ssh']) {
      expect(isOk(await phone.next(id))).toBe(true)
    }
    expect(passthroughOpens.count).toBe(opensBefore)
  })
  it.each([false, true])(
    'binds generic GitHub writes to the actual final socket after re-pairing to capable=%s B',
    async (capable) => {
      const { host, desktop, state } = await startTopology()
      const aWrite = vi.spyOn(host.runtime, 'updateRepoIssue').mockResolvedValue({ ok: true })
      const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
      phone.send('probe-a', 'status.get', {})
      const parseStatus = z.object({
        runtimeId: z.string(),
        hostDescriptor: z.object({ installationId: z.string() })
      })
      const a = parseStatus.parse((await phone.next('probe-a')).result)
      const expectedA = { sourceId: a.hostDescriptor.installationId, runtimeId: a.runtimeId }
      const params = {
        repo: 'id:repo-1',
        number: 93,
        updates: { state: 'closed' },
        ownerRepo: { owner: 'fork', repo: 'widgets' }
      }
      const { ownerRepo, ...legacyParams } = params
      const authorityReplies = () =>
        passthroughOpens.hostReplies.filter((frame) =>
          JSON.parse(frame).id?.startsWith('relay-github-authority:')
        )
      const authorityRepliesBefore = authorityReplies().length
      for (const [index, optional] of [
        { params: legacyParams, source: undefined },
        { params, source: undefined },
        { params: legacyParams, source: expectedA }
      ].entries()) {
        aWrite.mockClear()
        const id = `optional-github-${index}`
        phone.send(id, 'github.updateIssue', optional.params, TARGET, optional.source)
        expect(await phone.next(id)).toMatchObject({ ok: true, result: { ok: true } })
        expect(aWrite).toHaveBeenCalledExactlyOnceWith(
          params.repo,
          params.number,
          params.updates,
          ...(optional.params === params ? [ownerRepo] : [])
        )
        expect(passthroughOpens.hostReplies.some((frame) => JSON.parse(frame).id === id)).toBe(true)
      }
      aWrite.mockClear()
      for (const [index, invalidOwner] of [null, { owner: '', repo: 'widgets' }].entries()) {
        const id = `malformed-github-${index}`
        const malformed = { ...params, ownerRepo: invalidOwner }
        phone.send(id, 'github.updateIssue', malformed, TARGET, expectedA)
        expect((await phone.next(id)).ok).toBe(false)
        expect(aWrite).not.toHaveBeenCalled()
      }
      expect(authorityReplies()).toHaveLength(authorityRepliesBefore)
      expect(classifyExactGitHubOperation('github.listLabels', params, {})).toBeNull()
      phone.send('stable-a', 'github.updateIssue', params, TARGET, expectedA)
      expect(isOk(await phone.next('stable-a'))).toBe(true)
      expect(aWrite).toHaveBeenCalledWith('id:repo-1', 93, { state: 'closed' }, params.ownerRepo)
      const details = vi.spyOn(host.runtime, 'getRepoWorkItemDetails').mockResolvedValue(null)
      const originalStatus = host.runtime.getStatus.bind(host.runtime)
      const status = vi.spyOn(host.runtime, 'getStatus').mockImplementation(() => ({
        ...originalStatus(),
        capabilities: (originalStatus().capabilities ?? []).filter(
          (value) => value !== GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY
        )
      }))
      const read = { repo: params.repo, number: 93, type: 'issue', ownerRepo }
      const beforeIntent = authorityReplies().length
      phone.send(
        'intent-old-executor',
        'github.workItemDetails',
        { ...read, canonical: false },
        TARGET,
        expectedA
      )
      expect(await phone.next('intent-old-executor')).toMatchObject({
        ok: false,
        error: {
          code: 'remote_runtime_unavailable',
          message: GITHUB_EXACT_OPERATION_UNSUPPORTED
        }
      })
      expect(details).not.toHaveBeenCalled()
      expect(authorityReplies()).toHaveLength(beforeIntent + 1)
      status.mockRestore()
      for (const canonical of [false, true]) {
        const before = authorityReplies().length
        const id = `intent-${canonical}`
        phone.send(id, 'github.workItemDetails', { ...read, canonical }, TARGET, expectedA)
        expect(await phone.next(id)).toMatchObject({ ok: true, result: null })
        expect(details).toHaveBeenLastCalledWith(read.repo, 93, 'issue', ownerRepo, canonical)
        expect(authorityReplies()).toHaveLength(before + 1)
      }

      const b = await startRuntime()
      const bWrite = vi.spyOn(b.runtime, 'updateRepoIssue').mockResolvedValue({ ok: true })
      if (!capable) {
        const original = b.runtime.getStatus.bind(b.runtime)
        vi.spyOn(b.runtime, 'getStatus').mockImplementation(() => ({
          ...original(),
          capabilities: []
        }))
      }
      state.pairing = pair(b.server, 'runtime', 'MacBook')
      state.retire('env-1')
      phone.send('stale-a', 'github.updateIssue', params, TARGET, expectedA)
      expect((await phone.next('stale-a')).ok).toBe(false)
      expect(bWrite).not.toHaveBeenCalled()
      expect(aWrite).toHaveBeenCalledOnce()
      if (capable) {
        phone.send('probe-b', 'status.get', {})
        const fresh = parseStatus.parse((await phone.next('probe-b')).result)
        phone.send('fresh-b', 'github.updateIssue', params, TARGET, {
          sourceId: fresh.hostDescriptor.installationId,
          runtimeId: fresh.runtimeId
        })
        expect(isOk(await phone.next('fresh-b'))).toBe(true)
        expect(bWrite).toHaveBeenCalledOnce()
      }
    }
  )

  it('retires an in-flight same-socket proof, settles its claim and never forwards the old mutation on a replacement', async () => {
    const { host, desktop, state } = await startTopology()
    const write = vi.spyOn(host.runtime, 'updateRepoIssue').mockResolvedValue({ ok: true })
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    phone.send('initial', 'status.get', {})
    const status = z
      .object({ runtimeId: z.string(), hostDescriptor: z.object({ installationId: z.string() }) })
      .parse((await phone.next('initial')).result)
    passthroughOpens.holdStatus = true
    const params = {
      repo: 'id:repo-1',
      number: 93,
      ownerRepo: { owner: 'fork', repo: 'widgets' },
      updates: { state: 'closed' }
    }
    const expected = { sourceId: status.hostDescriptor.installationId, runtimeId: status.runtimeId }
    phone.send('retired', 'github.updateIssue', params, TARGET, expected)
    await vi.waitFor(() => expect(passthroughOpens.heldStatus).toHaveLength(1))
    state.retire('env-1')
    expect((await phone.next('retired')).ok).toBe(false)
    const opensAfterRetirement = passthroughOpens.count
    passthroughOpens.holdStatus = false
    for (const release of passthroughOpens.heldStatus.splice(0)) {
      release()
    }
    // A fresh unrelated request is the legitimate wake; old work never opens another socket.
    phone.send('healthy', 'status.get', {})
    expect(isOk(await phone.next('healthy'))).toBe(true)
    expect(passthroughOpens.count).toBe(opensAfterRetirement + 1)
    expect(write).not.toHaveBeenCalled()
    phone.send('retry', 'github.updateIssue', params, TARGET, expected)
    expect(isOk(await phone.next('retry'))).toBe(true)
    expect(write).toHaveBeenCalledOnce()
    expect(phone.frames.filter((frame) => frame.id === 'retired')).toHaveLength(1)
  })
  it('retires during the actual passthrough socket open and settles without forwarding or opening a replacement', async () => {
    const { host, desktop, state } = await startTopology()
    const write = vi.spyOn(host.runtime, 'updateRepoIssue').mockResolvedValue({ ok: true })
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    phone.send('probe-open', 'status.get', {})
    const status = z
      .object({ runtimeId: z.string(), hostDescriptor: z.object({ installationId: z.string() }) })
      .parse((await phone.next('probe-open')).result)
    state.retire('env-1')
    passthroughOpens.holdOpen = true
    const expected = { sourceId: status.hostDescriptor.installationId, runtimeId: status.runtimeId }
    const params = {
      repo: 'id:repo-1',
      number: 93,
      ownerRepo: { owner: 'fork', repo: 'widgets' },
      updates: { state: 'closed' }
    }
    phone.send('opening', 'github.updateIssue', params, TARGET, expected)
    await vi.waitFor(() => expect(passthroughOpens.heldOpen).toHaveLength(1))
    const opens = passthroughOpens.count
    state.retire('env-1')
    expect((await phone.next('opening')).ok).toBe(false)
    passthroughOpens.holdOpen = false
    for (const release of passthroughOpens.heldOpen.splice(0)) {
      release()
    }
    phone.send('retry-open', 'github.updateIssue', params, TARGET, expected)
    expect(isOk(await phone.next('retry-open'))).toBe(true)
    expect(passthroughOpens.count).toBe(opens + 1)
    expect(write).toHaveBeenCalledOnce()
    expect(phone.frames.filter((frame) => frame.id === 'opening')).toHaveLength(1)
  })
})
