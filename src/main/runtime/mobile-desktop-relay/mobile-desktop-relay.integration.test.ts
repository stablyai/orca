import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../../../shared/e2ee-crypto'
import { parsePairingCode, type PairingOffer } from '../../../shared/pairing'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../shared/delegated-mobile-device-contract'
import { decodeTerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime-client'
import { OrcaRuntimeService } from '../orca-runtime'
import { readRuntimeMetadata } from '../runtime-metadata'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { sendRequest } from '../runtime-rpc-test-harness'
import { makeStore } from '../runtime-rpc-worktree-store-fixtures'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import type * as PassthroughSocketModule from '../../../shared/remote-runtime-passthrough-socket'

const passthroughOpens = vi.hoisted(() => {
  const hostReplies: string[] = []
  return { count: 0, hostReplies }
})
vi.mock('../../../shared/remote-runtime-passthrough-socket', async (importOriginal) => {
  const original = await importOriginal<typeof PassthroughSocketModule>()
  return {
    ...original,
    openRemoteRuntimePassthroughSocket: (
      ...[pairing, capabilities, callbacks, options]: Parameters<
        typeof original.openRemoteRuntimePassthroughSocket
      >
    ) => {
      passthroughOpens.count += 1
      return original.openRemoteRuntimePassthroughSocket(
        pairing,
        capabilities,
        {
          ...callbacks,
          onText: (plaintext) => {
            passthroughOpens.hostReplies.push(plaintext)
            callbacks.onText(plaintext)
          }
        },
        options
      )
    }
  }
})

vi.mock('../../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

/** Exposes the per-terminal phone seats the runtime keeps behind a protected map. */
class SeatObservableRuntime extends OrcaRuntimeService {
  seatClientIds(ptyId: string): string[] {
    return [...(this.mobileSubscribers.get(ptyId)?.keys() ?? [])]
  }
}

const WORKTREE = 'id:repo-1::/tmp/worktree-a'
const TARGET = 'runtime:env-1'
type Frame = Record<string, unknown>

describe('mobile desktop relay: phone -> desktop -> server', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function startRuntime(spawnedOnThisHost: string[] = []) {
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
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())
    return { server, runtime, writes, userDataPath }
  }

  function pair(
    server: OrcaRuntimeRpcServer,
    scope: 'mobile' | 'runtime',
    name: string
  ): PairingOffer {
    const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    return parsePairingCode(offer.pairingUrl)!
  }

  /** A server, and a desktop whose only configured server is it, as `env-1`. */
  async function startTopology() {
    const host = await startRuntime()
    const desktopSpawns: string[] = []
    const desktop = await startRuntime(desktopSpawns)
    const desktopOnHost = pair(host.server, 'runtime', 'MacBook')
    const registry = host.server.getDeviceRegistry()!
    const children = () => registry.listDelegatedMobileDevices(desktopOnHost.pairedDeviceId!)
    const syncedNames: string[][] = []
    const retirementListeners = new Set<(environmentId: string) => void>()
    const state = {
      capable: true,
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
          ? { environmentId, fence: 'pairing-1', pairing: desktopOnHost }
          : null,
      call: async (_host, method, params) => {
        if (method === DELEGATED_MOBILE_DEVICE_SYNC_METHOD) {
          const { phones } = DelegatedMobileDeviceSyncParamsSchema.parse(params)
          syncedNames.push(phones.map((phone) => phone.name))
        }
        const response = await sendRemoteRuntimeRequest(desktopOnHost, method, params, 5_000)
        // An older server: the same status without the delegated-devices capability.
        return method === 'status.get' && !state.capable && response.ok
          ? {
              ...response,
              result: { ...z.object({}).passthrough().parse(response.result), capabilities: [] }
            }
          : response
      },
      onEnvironmentRetired: (listener) => {
        retirementListeners.add(listener)
        return () => retirementListeners.delete(listener)
      }
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

  async function connectPhone(desktop: OrcaRuntimeRpcServer, name: string) {
    const pairing = pair(desktop, 'mobile', name)
    const keys = generateKeyPair()
    const sharedKey = deriveSharedKey(keys.secretKey, publicKeyFromBase64(pairing.publicKeyB64))
    const ws = new WebSocket(pairing.endpoint)
    const frames: Frame[] = []
    const binaries: Uint8Array[] = []
    let authenticated = false
    const ready = new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer, isBinary) => {
        if (isBinary) {
          binaries.push(decryptBytes(new Uint8Array(data), sharedKey)!)
          return
        }
        const text = data.toString()
        if (text.includes('e2ee_ready')) {
          ws.send(
            encrypt(
              JSON.stringify({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }),
              sharedKey
            )
          )
          return
        }
        const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(decrypt(text, sharedKey)!))
        if (!authenticated) {
          authenticated = frame.type === 'e2ee_authenticated'
          resolve()
          return
        }
        frames.push(frame)
      })
    })
    ws.once('open', () =>
      ws.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(keys.publicKey) })
      )
    )
    await ready
    cleanups.push(() => ws.close())
    const token = pairing.deviceToken
    return {
      token,
      deviceId: pairing.pairedDeviceId!,
      frames,
      binaries,
      close: () => ws.close(),
      send(id: string, method: string, params: unknown, executionHost: string | null = TARGET) {
        ws.send(
          encrypt(
            JSON.stringify({
              id,
              deviceToken: token,
              method,
              params,
              executionHost: executionHost ?? undefined
            }),
            sharedKey
          )
        )
      },
      next: (id: string, predicate: (frame: Frame) => boolean = () => true) =>
        vi.waitFor(() => {
          const frame = frames.find((candidate) => candidate.id === id && predicate(candidate))
          expect(frame).toBeDefined()
          return frame!
        })
    }
  }
  type Phone = Awaited<ReturnType<typeof connectPhone>>

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
    // A phone another desktop relays to this one is that desktop's to relay, never re-relayed.
    const registry = desktop.server.getDeviceRegistry()!
    const otherDesktop = registry.getDevice(
      pair(desktop.server, 'runtime', 'Other Mac').pairedDeviceId!
    )!
    registry.upsertDelegatedMobileDevices(otherDesktop, [
      { phoneKey: 'p', name: 'iPad via Other Mac' }
    ])
    const phone = await connectPhone(desktop.server, 'iPhone')

    const streamId = await subscribe(phone, handle)
    // Host and desktop share a process counter here, so compare against the id the host sent.
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
    // The snapshot arrives as binary frames under the id the phone was given, never the host's.
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
    // The host seats the phone's delegated device, never the desktop's token for it.
    expect(host.runtime.seatClientIds('pty-shared')).toEqual([delegated.token])

    phone.send('in', 'terminal.send', {
      terminal: handle,
      text: 'ls',
      client: { id: phone.token, type: 'mobile' }
    })
    expect(isOk(await phone.next('in'))).toBe(true)
    expect(host.writes).toContain('ls')
    // terminal.send cross-checks client.id against the socket's device: only a swapped token passes.
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
    const phoneA = await connectPhone(desktop.server, 'Phone A')
    const phoneB = await connectPhone(desktop.server, 'Phone B')
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
    const phone = await connectPhone(desktop.server, 'iPhone')
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
    // The server applied it to the relayed phone's socket; its answer stays with the relay.
    await vi.waitFor(() =>
      expect(
        passthroughOpens.hostReplies.some((frame) =>
          frame.includes('"clientCapabilities":["relay.test.v1"]')
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
    const kept = await connectPhone(desktop.server, 'Kept')
    const unpaired = await connectPhone(desktop.server, 'Unpaired')
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
    const phone = await connectPhone(desktop.server, 'iPhone')
    await subscribe(phone, handle)
    const revoked = children()[0]!

    await host.server.revokeMobileDevice(revoked.deviceId)
    // The open stream ends as unavailable, never as an unpaired phone.
    expect(errorCode(await phone.next('sub', (frame) => frame.ok === false))).toBe(
      'remote_runtime_unavailable'
    )
    const opensBefore = passthroughOpens.count
    phone.send('after-1', 'terminal.list', {})
    expect(errorCode(await phone.next('after-1'))).toBe('remote_runtime_unavailable')
    phone.send('after-2', 'terminal.list', {})
    expect(errorCode(await phone.next('after-2'))).toBe('remote_runtime_unavailable')
    // One refused attempt, then no retries of the dead token.
    expect(passthroughOpens.count - opensBefore).toBe(1)

    state.retire('env-1')
    phone.send('after-sync', 'terminal.list', {})
    expect(isOk(await phone.next('after-sync'))).toBe(true)
  })

  it('answers a targeted desktop-owned call on the desktop, exactly as the untargeted one', async () => {
    const { desktop } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone')
    const opensBefore = passthroughOpens.count

    phone.send('settings:targeted', 'settings.get', {})
    phone.send('settings:untargeted', 'settings.get', {}, null)
    const targeted = await phone.next('settings:targeted')
    expect(isOk(targeted)).toBe(true)
    expect(targeted.result).toEqual((await phone.next('settings:untargeted')).result)
    expect(passthroughOpens.count).toBe(opensBefore)
    // An execution-host method under the same target still relays.
    phone.send('list', 'terminal.list', {})
    expect(isOk(await phone.next('list'))).toBe(true)
    expect(passthroughOpens.count).toBe(opensBefore + 1)
  })

  it('answers a targeted status from the server, so a server workspace gates on its own features', async () => {
    const { host, desktop } = await startTopology()
    const phone = await connectPhone(desktop.server, 'iPhone')
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
    const phone = await connectPhone(desktop.server, 'iPhone')
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
    const phone = await connectPhone(desktop.server, 'iPhone')

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
    // No target, `local` and the desktop's own SSH hosts are today's local call.
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
    const phone = await connectPhone(desktop.server, 'iPhone')
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
})
