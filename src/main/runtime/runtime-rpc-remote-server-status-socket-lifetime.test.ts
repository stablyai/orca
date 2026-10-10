import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WebSocketTransport } from './rpc/ws-transport'
import WebSocket from 'ws'
import { sendRequest } from './runtime-rpc-test-harness'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { parsePairingCode } from '../../shared/pairing'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { readRuntimeMetadata } from './runtime-metadata'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { RpcDispatcher } from './rpc/dispatcher'
import { STATUS_METHODS } from './rpc/methods/status'
import { sshBridgeCredentials } from './rpc/ssh-bridge-credentials'

async function readLocalStatus(path: string): Promise<{ result: RuntimeStatus }> {
  const metadata = readRuntimeMetadata(path)!
  const response = await sendRequest(metadata.transports[0]!.endpoint, {
    id: 'status-test',
    method: 'status.get',
    authToken: metadata.authToken,
    params: { includeRemoteServer: true }
  })
  expect(response.ok).toBe(true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture invokes the real status handler; assertions below validate its returned fields.
  return { result: response.result as RuntimeStatus }
}

async function withServer(
  run: (server: OrcaRuntimeRpcServer, path: string, runtime: OrcaRuntimeService) => Promise<void>
): Promise<void> {
  const path = mkdtempSync(join(tmpdir(), 'orca-server-status-'))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: path,
    enableWebSocket: true,
    wsPort: 0,
    pinnedBindHost: '127.0.0.1'
  })
  try {
    await server.start()
    await run(server, path, runtime)
  } finally {
    await server.stop()
    rmSync(path, { recursive: true, force: true })
  }
}

function connect(
  server: OrcaRuntimeRpcServer,
  scope: 'runtime' | 'mobile'
): RemoteRuntimeRequestConnection {
  const offer = server.createPairingOffer({
    name: `${scope} test client`,
    scope,
    reach: 'this-computer'
  })
  if (!offer.available) {
    throw new Error('Test pairing unavailable')
  }
  const pairing = parsePairingCode(offer.pairingUrl)
  if (!pairing) {
    throw new Error('Invalid test pairing')
  }
  return new RemoteRuntimeRequestConnection(pairing)
}

it('reports the actual loopback listener through local CLI status without changing exposure', async () => {
  await withServer(async (server, path) => {
    const endpoint = server.getWebSocketEndpoint()
    const status = await readLocalStatus(path)
    expect(status.result).toMatchObject({
      remoteServer: {
        listener: {
          state: 'listening',
          address: '127.0.0.1',
          port: Number(new URL(endpoint!).port)
        },
        grants: { state: 'available', total: 0, pending: 0, entries: [] },
        connectedClients: { state: 'available', count: 0, connectionCount: 0, entries: [] }
      }
    })
    expect(server.getWebSocketEndpoint()).toBe(endpoint)
    expect(server.getDeviceRegistry()?.listDevices()).toEqual([])
  })
})

it('separates grants from authenticated identities and sockets, respects caller scope, disconnect and revocation', async () => {
  await withServer(async (server, path, runtime) => {
    // Create both connections before authentication so they share the same pending grant.
    const first = connect(server, 'runtime')
    const second = connect(server, 'runtime')
    const phone = connect(server, 'mobile')
    const unauthenticated = new WebSocket(server.getWebSocketEndpoint()!)
    const readStatus = async () => (await readLocalStatus(path)).result.remoteServer
    try {
      await once(unauthenticated, 'open')
      const hello = once(unauthenticated, 'message')
      unauthenticated.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: server.getE2EEPublicKey() })
      )
      await hello
      expect(await readStatus()).toMatchObject({
        grants: { total: 2, pending: 2 },
        connectedClients: { count: 0, connectionCount: 0 }
      })
      const reply = await first.request<RuntimeStatus>(
        'status.get',
        { includeRemoteServer: true },
        5000
      )
      expect(reply).toMatchObject({
        ok: true,
        result: { remoteServer: { connectedClients: { count: 1, connectionCount: 1 } } }
      })
      await second.request('status.get', undefined, 5000)
      const mobileReply = await phone.request<RuntimeStatus>(
        'status.get',
        { clientKind: 'runtime', includeRemoteServer: true },
        5000
      )
      expect(mobileReply.ok).toBe(true)
      if (!mobileReply.ok) {
        throw new Error('Mobile status failed')
      }
      expect(mobileReply.result).not.toHaveProperty('remoteServer')
      const status = await readStatus()
      expect(status).toMatchObject({
        grants: { total: 2, pending: 0, byScope: { runtime: 1, mobile: 1 } },
        connectedClients: { count: 2, connectionCount: 3, byScope: { runtime: 1, mobile: 1 } }
      })
      expect(status?.connectedClients.state).toBe('available')
      if (status?.connectedClients.state !== 'available') {
        throw new Error('Missing clients')
      }
      expect(status.connectedClients.entries).toEqual(
        expect.arrayContaining([
          {
            deviceId: expect.any(String),
            name: 'runtime test client',
            scope: 'runtime',
            connectionCount: 2,
            transports: { direct: 2, relay: 0 }
          },
          {
            deviceId: expect.any(String),
            name: 'mobile test client',
            scope: 'mobile',
            connectionCount: 1,
            transports: { direct: 1, relay: 0 }
          }
        ])
      )
      const registry = server.getDeviceRegistry()!
      for (const device of registry.listDevices()) {
        expect(JSON.stringify(status)).not.toContain(device.token)
      }
      registry.flushPendingLastSeen()
      const stored = readFileSync(join(path, DEVICE_REGISTRY_FILENAME), 'utf8')
      await readStatus()
      await readStatus()
      expect(readFileSync(join(path, DEVICE_REGISTRY_FILENAME), 'utf8')).toBe(stored)
      const metadata = readRuntimeMetadata(path)!
      const denied = await sendRequest(metadata.transports[0]!.endpoint, {
        id: 'denied',
        method: 'status.get',
        authToken: 'invalid',
        params: { includeDetails: true }
      })
      expect(denied).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      expect(denied).not.toHaveProperty('result')
      const untrusted = new RpcDispatcher({ runtime, methods: STATUS_METHODS })
      const response = await untrusted.dispatch(
        {
          id: 'internal',
          authToken: '',
          method: 'status.get',
          params: { clientKind: 'runtime', includeRemoteServer: true }
        },
        { clientKind: 'runtime' }
      )
      expect(response).toMatchObject({ ok: true })
      if (!response.ok) {
        throw new Error('Internal status failed')
      }
      expect(response.result).not.toHaveProperty('remoteServer')
      second.close()
      await expect
        .poll(async () => (await readStatus())?.connectedClients)
        .toMatchObject({ count: 2, connectionCount: 2 })
      const runtimeDevice = registry.listDevices().find((device) => device.scope === 'runtime')!
      expect(server.revokeRuntimeAccess(runtimeDevice.deviceId)).toBe(true)
      await expect
        .poll(async () => (await readStatus())?.connectedClients)
        .toMatchObject({ count: 1, connectionCount: 1 })
      phone.close()
      await expect
        .poll(async () => (await readStatus())?.connectedClients)
        .toMatchObject({ count: 0, connectionCount: 0 })
      expect(await readStatus()).toMatchObject({
        grants: { total: 1, pending: 0 },
        listener: { address: '127.0.0.1' }
      })
    } finally {
      first.close()
      second.close()
      phone.close()
      unauthenticated.terminate()
    }
  })
})

it('does not retain configured or stale listener ports across start and stop', async () => {
  const path = mkdtempSync(join(tmpdir(), 'orca-listener-status-'))
  const runtime = new OrcaRuntimeService()
  const disabled = new OrcaRuntimeRpcServer({ runtime, userDataPath: path })
  expect(disabled['readRemoteServerStatus']().listener).toEqual({ state: 'disabled' })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: path,
    enableWebSocket: true,
    wsPort: 0,
    pinnedBindHost: '127.0.0.1'
  })
  expect(server['readRemoteServerStatus']().listener).toEqual({ state: 'not_listening' })
  try {
    await server.start()
    expect(server['readRemoteServerStatus']().listener).toMatchObject({
      state: 'listening',
      address: '127.0.0.1'
    })
  } finally {
    await server.stop()
    expect(server['readRemoteServerStatus']().listener).toEqual({ state: 'not_listening' })
    rmSync(path, { recursive: true, force: true })
  }
})

it('reports listener failure without inventing a port, and keeps two server instances separate', async () => {
  const fail = vi
    .spyOn(WebSocketTransport.prototype, 'start')
    .mockRejectedValueOnce(new Error('synthetic bind failure'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await withServer(async (_server, path) => {
      expect((await readLocalStatus(path)).result.remoteServer).toMatchObject({
        listener: { state: 'not_listening' },
        grants: { state: 'available', total: 0 },
        connectedClients: { state: 'unavailable' }
      })
    })
  } finally {
    fail.mockRestore()
    log.mockRestore()
  }
  await withServer(async (first, firstPath, firstRuntime) => {
    first.getDeviceRegistry()!.addDevice('First server only', 'runtime', 'this-computer')
    await withServer(async (_second, secondPath, secondRuntime) => {
      const a = (await readLocalStatus(firstPath)).result
      const b = (await readLocalStatus(secondPath)).result
      expect(a.runtimeId).toBe(firstRuntime.getRuntimeId())
      expect(b.runtimeId).toBe(secondRuntime.getRuntimeId())
      expect(a.remoteServer?.grants).toMatchObject({ total: 1, pending: 1 })
      expect(b.remoteServer?.grants).toMatchObject({ total: 0, pending: 0 })
    })
  })
})

it('keeps routine status probes free of diagnostics even for authorized callers', async () => {
  await withServer(async (server, path) => {
    const inventory = vi.spyOn(server.getDeviceRegistry()!, 'listDevices')
    const metadata = readRuntimeMetadata(path)!
    for (const params of [undefined, { includeRemoteServer: false }]) {
      const response = await sendRequest(metadata.transports[0]!.endpoint, {
        id: 'probe',
        method: 'status.get',
        authToken: metadata.authToken,
        params
      })
      expect(response.ok).toBe(true)
      expect(response.result).not.toHaveProperty('remoteServer')
    }
    const client = connect(server, 'runtime')
    try {
      const probe = await client.request<RuntimeStatus>('status.get', undefined, 5000)
      expect(probe.ok).toBe(true)
      if (!probe.ok) {
        throw new Error('Probe failed')
      }
      expect(probe.result).not.toHaveProperty('remoteServer')
      expect(inventory).not.toHaveBeenCalled()
      const requested = await client.request<RuntimeStatus>(
        'status.get',
        { includeRemoteServer: true },
        5000
      )
      expect(requested).toMatchObject({
        ok: true,
        result: { remoteServer: { connectedClients: { count: 1 } } }
      })
      expect(inventory).toHaveBeenCalledOnce()
    } finally {
      inventory.mockRestore()
      client.close()
    }
  })
})

it('withholds server diagnostics from SSH bridge credentials on the owner socket', async () => {
  await withServer(async (server, path) => {
    const metadata = readRuntimeMetadata(path)!
    const read = vi.fn(server['readRemoteServerStatus'].bind(server))
    server['readRemoteServerStatus'] = read
    for (const remoteCliControl of [false, true]) {
      const credential = sshBridgeCredentials.mint({
        kind: 'ssh-bridge',
        targetId: 'box-1',
        remoteCliControl
      })
      try {
        const response = await sendRequest(metadata.transports[0]!.endpoint, {
          id: 'bridge',
          method: 'status.get',
          authToken: credential.token,
          params: { includeRemoteServer: true }
        })
        expect(response.ok).toBe(true)
        expect(response.result).not.toHaveProperty('remoteServer')
      } finally {
        credential.revoke()
      }
    }
    expect(read).not.toHaveBeenCalled()
    expect((await readLocalStatus(path)).result.remoteServer).toBeDefined()
    expect(read).toHaveBeenCalledOnce()
  })
})
