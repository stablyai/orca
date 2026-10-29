import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../shared/github/work-item-target'
import { GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY } from '../../../shared/task-source-runtime-capabilities'
import { classifyExactGitHubOperation } from '../../../shared/github/exact-work-item-operation'
import '../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { decodeTerminalStreamFrame } from '../../../shared/terminal/stream/terminal-stream-protocol'
import { mintBrowserScreencastSubscriptionId } from '../browser/screencast/browser-screencast-subscription-id'
import { setRuntimeBrowserCommandsFactory } from '../browser/installation/runtime-browser-commands-factory'
import { MOBILE_RPC_METHOD_ROUTES } from '../rpc/server/runtime-rpc-mobile-method-routing'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../rpc/server/runtime-rpc-mobile-method-allowlist'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../shared/mobile-desktop-relay-contract'
import type * as PassthroughSocketModule from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import { connectPhone, pair, TARGET, type Frame } from './mobile-desktop-relay-phone.test-fixture'
import { createRelayTopology, WORKTREE } from './relay-topology.test-fixture'

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

  const { startRuntime, startTopology } = createRelayTopology(cleanups)
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

  it('keeps a target missing the locator as a refusal, with no relay-local substitution', async () => {
    const { desktop, handle } = await startTopology(false)
    const phone = await connectPhone(desktop.server, 'old-target', cleanups)
    const local = vi.spyOn(desktop.runtime, 'getTerminalPaneKey')
    phone.send('old-target', 'orchestration.partyLocation', { address: handle })
    expect(await phone.next('old-target')).toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
    expect(local).not.toHaveBeenCalled()
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

  it('gives two phones on one server terminal their own seats, and cleans up the one that disconnects', async () => {
    const { host, desktop, children, handle } = await startTopology()
    const phoneA = await connectPhone(desktop.server, 'Phone A', cleanups)
    const phoneB = await connectPhone(desktop.server, 'Phone B', cleanups)
    const streamA = await subscribe(phoneA, handle)
    const streamB = await subscribe(phoneB, handle)
    expect(streamA).not.toBe(streamB)
    const tokens = children().map((device) => device.token)
    expect(new Set(tokens).size).toBe(2)
    expect(host.runtime.seatClientIds('pty-shared').sort()).toEqual([...tokens].sort())

    phoneA.close()
    await vi.waitFor(() => expect(host.runtime.seatClientIds('pty-shared')).toHaveLength(1))
    expect(host.runtime.seatClientIds('pty-shared')).not.toContain(tokens[0])
  })

  it('applies a phone capability update on the desktop and on its open server socket, answering once', async () => {
    const { desktop, handle } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    await subscribe(phone, handle)
    phone.send(
      'caps',
      'runtime.clientCapabilities.update',
      { clientCapabilities: ['relay.test.v1'] },
      null
    )
    expect(await phone.next('caps')).toMatchObject({
      ok: true,
      result: { clientCapabilities: ['relay.test.v1'] }
    })
    await vi.waitFor(() =>
      expect(
        passthroughOpens.hostReplies.some((frame) =>
          // Client-placed tabs require the declared capability.
          frame.includes('"clientCapabilities":["relay.test.v1","browser.clientHost.v1"]')
        )
      ).toBe(true)
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      phone.frames.filter((frame) => frame.id === 'caps' || String(frame.id).startsWith('relay-'))
    ).toHaveLength(1)
  })

  it('drops a phone from the server as soon as the desktop unpairs it', async () => {
    const { host, desktop, children, handle } = await startTopology()
    const kept = await connectPhone(desktop.server, 'Kept', cleanups)
    const unpaired = await connectPhone(desktop.server, 'Unpaired', cleanups)
    await subscribe(kept, handle)
    expect(children().map((device) => device.phoneKey)).toEqual([kept.deviceId, unpaired.deviceId])

    await desktop.server.revokeMobileDevice(unpaired.deviceId)
    await vi.waitFor(() =>
      expect(children().map((device) => device.phoneKey)).toEqual([kept.deviceId])
    )
    expect(host.runtime.seatClientIds('pty-shared')).toEqual([children()[0]!.token])
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

  it('answers a targeted desktop-owned call on the desktop, exactly as the untargeted one', async () => {
    const { host, desktop } = await startTopology()
    vi.spyOn(host.runtime, 'getClientAgentLaunchSettings').mockReturnValue({
      ...host.runtime.getClientAgentLaunchSettings(),
      defaultTuiAgent: 'pi',
      disabledTuiAgents: ['claude']
    })
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    const opensBefore = passthroughOpens.count

    phone.send('settings:targeted', 'settings.get', {})
    phone.send('settings:untargeted', 'settings.get', {}, null)
    const targeted = await phone.next('settings:targeted')
    expect(isOk(targeted)).toBe(true)
    expect(targeted.result).toEqual((await phone.next('settings:untargeted')).result)
    expect(passthroughOpens.count).toBe(opensBefore)
    phone.send('automation:policy', 'settings.getAgentLaunch', {})
    expect(await phone.next('automation:policy')).toMatchObject({
      ok: true,
      result: { settings: { defaultTuiAgent: 'pi', disabledTuiAgents: ['claude'] } }
    })
    phone.send('automation:workspaces', 'worktree.list', {})
    expect(await phone.next('automation:workspaces')).toMatchObject({
      ok: true,
      result: { worktrees: expect.any(Array) }
    })
    // An execution-host method under the same target still relays.
    phone.send('list', 'terminal.list', {})
    expect(isOk(await phone.next('list'))).toBe(true)
    expect(passthroughOpens.count).toBe(opensBefore + 1)
  })

  it('serves a browser call on the desktop when the desktop renders that server page itself', async () => {
    const { host, desktop, state } = await startTopology()
    state.hostedPages.add('hosted-page')
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    const desktopGoto = vi.spyOn(desktop.runtime, 'browserGoto').mockResolvedValue({
      url: 'http://example.test/',
      title: 'Example'
    })
    const hostGoto = vi.spyOn(host.runtime, 'browserGoto').mockResolvedValue({
      url: 'http://example.test/',
      title: 'Example'
    })

    phone.send('hosted', 'browser.goto', {
      worktree: WORKTREE,
      page: 'hosted-page',
      url: 'http://example.test/'
    })
    expect(isOk(await phone.next('hosted'))).toBe(true)
    expect(desktopGoto).toHaveBeenCalledWith({ page: 'hosted-page', url: 'http://example.test/' })
    expect(hostGoto).not.toHaveBeenCalled()

    phone.send('server', 'browser.goto', {
      worktree: WORKTREE,
      page: 'server-page',
      url: 'http://example.test/'
    })
    expect(isOk(await phone.next('server'))).toBe(true)
    expect(hostGoto).toHaveBeenCalledWith(expect.objectContaining({ page: 'server-page' }))
    expect(desktopGoto).toHaveBeenCalledTimes(1)
  })

  it('streams a desktop-hosted page and releases it through the subscription id, never on the server', async () => {
    const { host, desktop, state } = await startTopology()
    state.hostedPages.add('hosted-page')
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    const subscriptionId = mintBrowserScreencastSubscriptionId('hosted-page', 'nonce')
    let release = (): void => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    const desktopScreencast = vi
      .spyOn(desktop.runtime, 'browserScreencast')
      .mockImplementation(async (_params, stream) => {
        stream.emit?.({
          type: 'ready',
          subscriptionId,
          browserPageId: 'hosted-page',
          format: 'jpeg',
          tab: {
            browserPageId: 'hosted-page',
            index: 0,
            url: 'http://a.test/',
            title: 'A',
            active: true
          }
        })
        await released
      })
    const desktopCleanup = vi
      .spyOn(desktop.runtime, 'cleanupSubscription')
      .mockImplementation(() => release())
    const hostScreencast = vi.spyOn(host.runtime, 'browserScreencast')
    const hostCleanup = vi.spyOn(host.runtime, 'cleanupSubscription')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unsubscribe only checks a provider exists; the spies replace every command it would reach.
    setRuntimeBrowserCommandsFactory(() => ({}) as never)
    cleanups.push(() => setRuntimeBrowserCommandsFactory(null))

    phone.send('cast', 'browser.screencast', {
      worktree: WORKTREE,
      page: 'hosted-page',
      format: 'jpeg'
    })
    expect(
      await phone.next('cast', (frame) => JSON.stringify(frame).includes(subscriptionId))
    ).toMatchObject({ ok: true, result: { type: 'ready', subscriptionId } })
    expect(desktopScreencast).toHaveBeenCalledWith(
      { page: 'hosted-page', format: 'jpeg' },
      expect.anything()
    )

    phone.send('uncast', 'browser.screencast.unsubscribe', { subscriptionId })
    expect(await phone.next('uncast')).toMatchObject({ ok: true, result: { unsubscribed: true } })
    expect(desktopCleanup).toHaveBeenCalledWith(subscriptionId)
    expect(hostScreencast).not.toHaveBeenCalled()
    expect(hostCleanup).not.toHaveBeenCalledWith(subscriptionId)
  })

  it('answers a targeted status from the server, so a server workspace gates on its own features', async () => {
    const { host, desktop } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    const StatusSchema = z.looseObject({ runtimeId: z.string(), capabilities: z.array(z.string()) })

    phone.send('status:server', 'status.get', {})
    phone.send('status:desktop', 'status.get', {}, null)
    const server = StatusSchema.parse((await phone.next('status:server')).result)
    const own = StatusSchema.parse((await phone.next('status:desktop')).result)
    expect(server.runtimeId).toBe(host.runtime.getRuntimeId())
    expect(own.runtimeId).toBe(desktop.runtime.getRuntimeId())
    expect(server.capabilities).toEqual(host.runtime.getStatus().capabilities)
  })

  it("answers a targeted SSH state from the server, which holds a server workspace's SSH targets", async () => {
    const { desktop } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    const answeredByServer = (id: string) =>
      passthroughOpens.hostReplies.some((frame) => JSON.parse(frame).id === id)

    phone.send('ssh:server', 'ssh.getState', { targetId: 'devbox' })
    phone.send('ssh:desktop', 'ssh.getState', { targetId: 'devbox' }, null)
    expect(isOk(await phone.next('ssh:server'))).toBe(true)
    expect(isOk(await phone.next('ssh:desktop'))).toBe(true)
    expect(answeredByServer('ssh:server')).toBe(true)
    expect(answeredByServer('ssh:desktop')).toBe(false)
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

  it('reports a server without delegated devices as update-needed and relays nothing to it', async () => {
    const { desktop, state } = await startTopology()
    state.capable = false
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    const opensBefore = passthroughOpens.count
    phone.send('list', 'terminal.list', {})
    expect(await phone.next('list')).toMatchObject({
      error: { code: 'remote_runtime_unavailable', message: expect.stringContaining('update') }
    })
    expect(passthroughOpens.count).toBe(opensBefore)
    state.capable = true
    state.retire('env-1')
    phone.send('updated', 'terminal.list', {})
    expect(isOk(await phone.next('updated'))).toBe(true)
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

  const capabilitiesOf = (frame: Frame) =>
    z.object({ result: z.object({ capabilities: z.array(z.string()) }) }).parse(frame).result
      .capabilities

  it('relays a paired desktop client to the server as its own delegated device, never handing it the server token', async () => {
    const { host, desktop, children, syncedNames, handle } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    const client = await connectPhone(desktop.server, 'Laptop', cleanups, 'runtime')

    client.send('status', 'status.get', {}, null)
    phone.send('status', 'status.get', {}, null)
    expect(capabilitiesOf(await client.next('status'))).toContain(
      RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY
    )
    expect(capabilitiesOf(await phone.next('status'))).not.toContain(
      RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY
    )
    // Pairing alone mints nothing on the server; no phone subscribes, so desktop input is not floor-paused.
    phone.send('phone-list', 'terminal.list', {})
    expect(isOk(await phone.next('phone-list'))).toBe(true)
    expect(children().map((device) => device.phoneKey)).toEqual([phone.deviceId])

    client.send('list', 'terminal.list', {})
    expect(isOk(await client.next('list'))).toBe(true)
    expect(passthroughOpens.hostReplies.some((frame) => JSON.parse(frame).id === 'list')).toBe(true)
    const delegated = children().find((device) => device.phoneKey === client.deviceId)!
    // A first step reuses the phone child scope on the server, which already allows every execution-host route.
    expect(delegated.scope).toBe('mobile')
    expect(syncedNames.at(-1)).toEqual([
      `iPhone via ${desktop.runtime.readMachineName()}`,
      `Laptop via ${desktop.runtime.readMachineName()}`
    ])
    client.send('in', 'terminal.send', {
      terminal: handle,
      text: 'pwd',
      client: { id: client.token, type: 'desktop' }
    })
    expect(sendAccepted(await client.next('in'))).toBe(true)
    expect(host.writes).toContain('pwd')

    client.send('watch', 'terminal.subscribe', {
      terminal: handle,
      client: { id: client.token, type: 'desktop' }
    })
    await client.next('watch')
    host.runtime.onPtyData('pty-shared', 'relayed-output', 1_700_000_000_000)
    await client.next('watch', (frame) => JSON.stringify(frame).includes('relayed-output'))
    expect(JSON.stringify(client.frames)).not.toContain(delegated.token)
  })

  it("keeps a paired desktop client's untargeted and desktop-owned calls on the desktop", async () => {
    const { desktop } = await startTopology()
    const client = await connectPhone(desktop.server, 'Laptop', cleanups, 'runtime')
    const opensBefore = passthroughOpens.count

    // Desktop-owned routes stay here even when targeted, as for phones; non-server targets are untouched.
    client.send('settings', 'settings.get', {})
    client.send('absent', 'terminal.list', {}, null)
    client.send('local', 'terminal.list', {}, 'local')
    client.send('ssh', 'terminal.list', {}, 'ssh:devbox')
    for (const id of ['settings', 'absent', 'local', 'ssh']) {
      expect(isOk(await client.next(id))).toBe(true)
    }
    expect(passthroughOpens.count).toBe(opensBefore)
  })

  it('never runs a server-targeted call from a paired desktop client on the desktop instead', async () => {
    const { desktop, desktopSpawns, children } = await startTopology()
    const client = await connectPhone(desktop.server, 'Laptop', cleanups, 'runtime')
    const desktopWrite = vi.spyOn(desktop.runtime, 'writeFileExplorerFile')
    const opensBefore = passthroughOpens.count

    // files.write is not relayable, so naming a server refuses it rather than writing on this computer.
    client.send('write', 'files.write', { worktree: WORKTREE, relativePath: 'a.txt', content: 'x' })
    expect(errorCode(await client.next('write'))).toBe('forbidden')
    client.send('garbled', 'terminal.list', {}, 'runtime:')
    expect(errorCode(await client.next('garbled'))).toBe('invalid_argument')
    expect(desktopWrite).not.toHaveBeenCalled()
    expect(passthroughOpens.count).toBe(opensBefore)

    client.send('multiplex', 'terminal.multiplex', {})
    expect(errorCode(await client.next('multiplex'))).toBe('forbidden')
    client.send(
      'unknown',
      'terminal.create',
      {
        worktree: WORKTREE,
        command: 'bash',
        tabId: 'tab-2',
        leafId: '22222222-2222-4222-8222-222222222222'
      },
      'runtime:env-unknown'
    )
    expect(errorCode(await client.next('unknown'))).toBe('remote_runtime_unavailable')
    expect(desktopSpawns).toEqual([])
    // Only a server the client reached gets a device for it; an unknown target enrolls it nowhere.
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    phone.send('phone-list', 'terminal.list', {})
    expect(isOk(await phone.next('phone-list'))).toBe(true)
    expect(children().map((device) => device.phoneKey)).toEqual([phone.deviceId])
  })

  it('runs a targeted call from a paired desktop client locally on a desktop that relays to no server', async () => {
    const desktop = await startRuntime()
    const client = await connectPhone(desktop.server, 'Laptop', cleanups, 'runtime')
    const opensBefore = passthroughOpens.count

    client.send('status', 'status.get', {}, null)
    expect(capabilitiesOf(await client.next('status'))).not.toContain(
      RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY
    )
    client.send('list', 'terminal.list', {})
    expect(isOk(await client.next('list'))).toBe(true)
    expect(passthroughOpens.count).toBe(opensBefore)
  })

  it("revokes a desktop client's server device when the desktop revokes the client, leaving its phones", async () => {
    const { desktop, children, handle } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone', cleanups)
    const client = await connectPhone(desktop.server, 'Laptop', cleanups, 'runtime')
    await subscribe(phone, handle)
    client.send('list', 'terminal.list', {})
    expect(isOk(await client.next('list'))).toBe(true)
    expect(children().map((device) => device.phoneKey)).toEqual([phone.deviceId, client.deviceId])

    expect(desktop.server.revokeRuntimeAccess(client.deviceId)).toBe(true)
    await vi.waitFor(() =>
      expect(children().map((device) => device.phoneKey)).toEqual([phone.deviceId])
    )
  })
})
