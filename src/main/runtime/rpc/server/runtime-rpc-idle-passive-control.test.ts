// #46567: a desktop's passive control socket must let its WSL host idle out, yet still count real use.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import { IDLE_PASSIVE_CONTROL_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import { RUNTIME_IDLE_STOPPED_ERROR_CODE } from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-idle-stop-signal'
import { defineMethod, defineStreamingMethod } from '../core'
import { STATUS_METHODS } from '../methods/host-management/status'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { installOrcadManagedIdleExit } from '../../../orcad/host-lifecycle/idle-exit/orcad-managed-idle-exit'

const METHODS = [
  ...STATUS_METHODS,
  defineMethod({
    name: 'test.work',
    permission: 'workspace',
    params: null,
    handler: async () => ({ done: true })
  }),
  defineMethod({
    name: 'notifications.reportDesktopPresence',
    permission: 'workspace',
    params: null,
    handler: async () => ({ ok: true })
  }),
  defineStreamingMethod({
    name: 'test.watch',
    permission: 'workspace',
    params: null,
    handler: (_params, { signal }, emit) =>
      new Promise<void>((resolve) => {
        emit({ watching: true })
        signal?.addEventListener('abort', () => resolve())
      })
  })
]

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startHostAndDesktop() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-idle-passive-control-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    methods: METHODS
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop().catch(() => {})
    rmSync(userDataPath, { recursive: true, force: true })
  })
  const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime', name: 'Desk' })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  let idleStopped = false
  const desktop = new RemoteRuntimeSharedControlConnection(
    pairedRuntimeConnectionFromOffer(parsePairingCode(offer.pairingUrl)!),
    {
      clientCapabilities: [IDLE_PASSIVE_CONTROL_CLIENT_CAPABILITY],
      isIdleStopped: () => idleStopped,
      onIdleStop: () => {
        idleStopped = true
      }
    }
  )
  cleanups.push(() => desktop.close())
  expect((await desktop.request('status.get', { probe: true }, 5_000)).ok).toBe(true)
  return { server, desktop, isIdleStopped: () => idleStopped }
}

describe('a passive desktop control socket', () => {
  it('does not hold idle exit open, but its ordinary requests are use', async () => {
    const { server, desktop } = await startHostAndDesktop()
    const quiet = server.readClientActivity()
    expect(quiet.openConnections).toBe(0)
    expect(quiet.requestsInFlight).toBe(0)

    await desktop.request('status.get', { probe: true }, 5_000)
    const poll = await desktop.request('test.work', null, 5_000, undefined, undefined, {
      idlePassive: true
    })
    expect(poll.ok).toBe(true)
    const streaming = Promise.withResolvers<void>()
    const watch = await desktop.subscribe('test.watch', null, 5_000, {
      onResponse: () => streaming.resolve(),
      onError: () => {}
    })
    await streaming.promise
    // The heartbeat, a request tagged background and an open stream are not use.
    expect(server.readClientActivity()).toEqual(quiet)

    expect((await desktop.request('test.work', null, 5_000)).ok).toBe(true)
    const used = server.readClientActivity()
    expect(used.requestsInFlight).toBe(0)
    expect(used.lastRequestAt).toBeGreaterThan(quiet.lastRequestAt)
    watch.close()
  })

  it('stays down after an idle stop, refusing undispatched requests, but recovers from a crash', async () => {
    const idle = await startHostAndDesktop()
    idle.server.fenceForIdleStop()
    await vi.waitFor(() => expect(idle.isIdleStopped()).toBe(true))
    await expect(idle.desktop.request('status.get', { probe: true }, 1_000)).rejects.toMatchObject({
      code: RUNTIME_IDLE_STOPPED_ERROR_CODE
    })
    // Held, not reconnecting: no retry timer was armed.
    expect(idle.desktop.getDiagnostics().state).toBe('closed')

    const crash = await startHostAndDesktop()
    await crash.server.stop()
    await vi.waitFor(() => expect(crash.desktop.getDiagnostics().state).toBe('reconnecting'))
    expect(crash.isIdleStopped()).toBe(false)
  })

  it('lets an open but untouched WSL workspace reach idle exit through all its traffic', async () => {
    const { server, desktop } = await startHostAndDesktop()
    const watch = await desktop.subscribe('test.watch', null, 5_000, {
      onResponse: () => {},
      onError: () => {}
    })
    let stopped = false
    const dispose = installOrcadManagedIdleExit({
      config: { timeoutMs: 400, activationRoot: tmpdir() },
      ports: {
        readClientActivity: () => server.readClientActivity(),
        listTerminals: async () => [],
        countDaemonSessions: async () => 0,
        hasDaemon: () => false,
        agentStates: () => [],
        hasChatProviders: () => false,
        hasStagedMigration: () => false,
        automationsBusy: () => false,
        emulatorsBusy: async () => false,
        activationFenceExists: async () => false
      },
      stop: () => {
        stopped = true
        return true
      }
    })
    cleanups.push(dispose)
    // What a visible workspace sends while nobody uses it: heartbeat, status and capability
    // reads, presence, and polls tagged background (ports, git status, PR refresh).
    const traffic = setInterval(() => {
      void desktop.request('status.get', { probe: true }, 5_000).catch(() => {})
      void desktop.request('status.get', undefined, 5_000).catch(() => {})
      void desktop.request('notifications.reportDesktopPresence', null, 5_000).catch(() => {})
      void desktop
        .request('test.work', null, 5_000, undefined, undefined, { idlePassive: true })
        .catch(() => {})
    }, 50)
    cleanups.push(() => clearInterval(traffic))
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 5_000 })
    watch.close()
  })
})
