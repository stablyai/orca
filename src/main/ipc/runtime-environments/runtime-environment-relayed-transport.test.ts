import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../shared/mobile-desktop-relay-contract'
import { toRelayedRuntimeEnvironmentId } from '../../../shared/relayed-runtime-environment'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer,
  type SharedControlTestRequest
} from '../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { encodePairingOffer } from '../../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../../shared/runtime-environment-store'
import { RemoteRuntimeSharedControlConnection } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import {
  closeRemoteRuntimeRequestConnection,
  getRemoteRuntimeSharedControlDiagnostics
} from './runtime-environment-request-connections'
import {
  callRelayedRuntimeEnvironment,
  getRelayedRuntimeEnvironmentStatus
} from './runtime-environment-relayed-transport'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

const OWNER_RUNTIME = 'runtime-a'
const SERVER_RUNTIME = 'runtime-b'
const HOST = 'runtime:vm-1'
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  await closeSharedControlTestServers()
})

type ServerHooks = Pick<Parameters<typeof createSharedControlTestServer>[0] & {}, 'errorForRequest'>

/** A as a real encrypted server: answers untargeted calls itself and targeted ones as B. */
async function relayingServer(state = { relays: true }, hooks: ServerHooks = {}) {
  const server = await createSharedControlTestServer({
    ...hooks,
    resultForRequest: (method, request: SharedControlTestRequest) => {
      const relayed = request.executionHost === HOST
      if (method === 'status.get') {
        return {
          runtimeId: relayed ? SERVER_RUNTIME : OWNER_RUNTIME,
          capabilities:
            !relayed && state.relays ? [RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY] : ['other.v1']
        }
      }
      return { answeredBy: relayed ? 'server' : 'owner' }
    }
  })
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relayed-transport-'))
  const owner = addEnvironmentFromPairingCode(userDataPath, {
    name: 'Box',
    pairingCode: encodePairingOffer(server.offer)
  })
  cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
  cleanups.push(() => closeRemoteRuntimeRequestConnection(owner.id))
  const relayedId = (pairingRevision = owner.pairingRevision ?? owner.createdAt) =>
    toRelayedRuntimeEnvironmentId({
      ownerEnvironmentId: owner.id,
      ownerPairingRevision: pairingRevision,
      executionHost: HOST
    })
  const sent = (method: string) => server.requests.filter((request) => request.method === method)
  return { server, state, userDataPath, owner, relayedId, sent }
}

describe('callRelayedRuntimeEnvironment', () => {
  it("sends a read to the relaying server's shared socket, naming the relayed server", async () => {
    const { server, userDataPath, owner, relayedId, sent } = await relayingServer()

    const response = await callRelayedRuntimeEnvironment(userDataPath, {
      selector: relayedId(),
      method: 'files.readDir',
      params: { worktree: 'id:wt', relativePath: '' }
    })

    expect(response).toMatchObject({ ok: true, result: { answeredBy: 'server' } })
    expect(sent('files.readDir')).toEqual([expect.objectContaining({ executionHost: HOST })])
    // The gate probe and the read share one socket: no one-shot handshake per call.
    expect(server.connectionCount()).toBe(1)
    // B's reply must never become A's stored identity, or A's revision guards break.
    expect(resolveEnvironment(userDataPath, owner.id).runtimeId).toBe(owner.runtimeId)
  })

  it("answers status with the relayed server's own status, not the relaying server's", async () => {
    const { userDataPath, relayedId } = await relayingServer()

    const status = await getRelayedRuntimeEnvironmentStatus(userDataPath, relayedId())

    expect(status).toMatchObject({ ok: true, result: { runtimeId: SERVER_RUNTIME } })
  })

  it('sends nothing to a relaying server that does not advertise the relay', async () => {
    const { userDataPath, relayedId, sent } = await relayingServer({ relays: false })

    const response = await callRelayedRuntimeEnvironment(userDataPath, {
      selector: relayedId(),
      method: 'git.status',
      params: { worktree: 'id:wt' }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'remote_runtime_unavailable' } })
    // An old server would answer from its own disk: a read from the wrong machine.
    expect(sent('git.status')).toEqual([])
  })

  it('re-proves the relay after a reconnect, so a downgrade stops the next read', async () => {
    const { server, state, userDataPath, relayedId, sent } = await relayingServer()
    const read = () =>
      callRelayedRuntimeEnvironment(userDataPath, {
        selector: relayedId(),
        method: 'files.stat',
        params: { worktree: 'id:wt', relativePath: 'a' }
      })
    expect(await read()).toMatchObject({ ok: true })

    state.relays = false
    server.closeClients()
    await vi.waitFor(() => expect(server.connectionCount()).toBe(2))

    expect(await read()).toMatchObject({
      ok: false,
      error: { code: 'remote_runtime_unavailable' }
    })
    expect(sent('files.stat')).toHaveLength(1)
  })

  it("passes on the relaying server's failed status and asks again on the next read", async () => {
    let busy = true
    const { userDataPath, relayedId, sent } = await relayingServer(undefined, {
      errorForRequest: (request) =>
        busy && request.method === 'status.get' && request.executionHost === undefined
          ? { code: 'runtime_busy', message: 'busy' }
          : null
    })
    const read = () =>
      callRelayedRuntimeEnvironment(userDataPath, {
        selector: relayedId(),
        method: 'git.diff',
        params: { worktree: 'id:wt' }
      })

    expect(await read()).toMatchObject({ ok: false, error: { code: 'runtime_busy' } })
    busy = false

    // A busy reply says nothing about the relay, so it must not be cached as "no relay".
    expect(await read()).toMatchObject({ ok: true, result: { answeredBy: 'server' } })
    expect(sent('git.diff')).toHaveLength(1)
  })

  it('never sends on a socket that replaced the one whose status advertised the relay', async () => {
    const state = { relays: true }
    const { server, userDataPath, owner, relayedId, sent } = await relayingServer(state)
    const request = RemoteRuntimeSharedControlConnection.prototype.request
    let swapped = false
    // Holds the gate's status until A's socket has dropped; A comes back as an older build.
    vi.spyOn(RemoteRuntimeSharedControlConnection.prototype, 'request').mockImplementation(
      function (this: RemoteRuntimeSharedControlConnection, ...args) {
        const response = request.apply(this, args)
        if (swapped || args[0] !== 'status.get') {
          return response
        }
        swapped = true
        return response.then(async (status) => {
          state.relays = false
          server.closeClients()
          await vi.waitFor(() =>
            expect(getRemoteRuntimeSharedControlDiagnostics(owner.id)?.state).not.toBe('ready')
          )
          return status
        })
      }
    )

    const response = await callRelayedRuntimeEnvironment(userDataPath, {
      selector: relayedId(),
      method: 'files.readDir',
      params: { worktree: 'id:wt', relativePath: '' }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'remote_runtime_unavailable' } })
    expect(sent('files.readDir')).toEqual([])
  })

  it('refuses a read minted for an earlier pairing of the relaying server', async () => {
    const { server, userDataPath, owner, relayedId, sent } = await relayingServer()
    const before = relayedId()
    updateEnvironmentFromPairingCode(userDataPath, owner.id, {
      pairingCode: encodePairingOffer({ ...server.offer, deviceToken: 'device-token-2' }),
      now: Date.now() + 1_000
    })

    const response = await callRelayedRuntimeEnvironment(userDataPath, {
      selector: before,
      method: 'files.read',
      params: { worktree: 'id:wt', relativePath: 'a' }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    expect(sent('files.read')).toEqual([])
  })

  it.each(['files.write', 'terminal.create', 'git.commit', 'browser.goto'])(
    'refuses %s without contacting any server',
    async (method) => {
      const { server, userDataPath, relayedId } = await relayingServer()

      const response = await callRelayedRuntimeEnvironment(userDataPath, {
        selector: relayedId(),
        method,
        params: {}
      })

      expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(server.connectionCount()).toBe(0)
    }
  )
})
