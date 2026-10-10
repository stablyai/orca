import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairedRuntimeBrowserNetworkRoute } from '../browser/paired-runtime-browser-network-route'
import { PairedRuntimeBrowserHostLease } from '../browser/paired-runtime-browser-host-lease'
import { parsePairingCode } from '../../shared/pairing'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { ALL_RPC_METHODS } from './rpc/methods'

const resources: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of resources.splice(0).toReversed()) {
    await cleanup()
  }
})

describe('paired runtime browser network tunnel', () => {
  it('returns page command results on the exact authenticated attach connection', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-command-'))
    resources.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const runtime = new OrcaRuntimeService({} as never)
    const rpc = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      methods: ALL_RPC_METHODS
    })
    await rpc.start()
    resources.push(() => rpc.stop())

    const offer = rpc.createPairingOffer({ name: 'browser-command', scope: 'runtime' })
    if (!offer.available) {
      throw new Error('Runtime pairing is unavailable')
    }
    const pairing = parsePairingCode(offer.pairingUrl)
    if (!pairing?.pairedDeviceId) {
      throw new Error('Runtime pairing identity is unavailable')
    }
    const errors: Error[] = []
    const onPageCommand = vi.fn(() => Promise.resolve({ status: 'completed' as const }))
    const hostLease = new PairedRuntimeBrowserHostLease({
      pairing,
      authorityRuntimeId: runtime.getRuntimeId(),
      browserHostClientId: 'integration-browser-host',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      onPageCommand,
      onError: (error) => errors.push(error)
    })
    await hostLease.start()
    resources.push(() => hostLease.close())

    const registry = getBrowserHostLeaseRegistry(runtime)
    const attached = registry.select('integration-browser-host')
    const settle = vi.spyOn(registry, 'settleClientPageCommand')
    const grant = registry.grantExecutionHost(
      {
        authorityEpoch: attached.authorityEpoch,
        browserHostClientId: attached.browserHostClientId,
        browserHostGeneration: attached.browserHostGeneration,
        pairedDeviceId: attached.pairedDeviceId
      },
      'native:integration'
    )
    resources.push(grant.release)
    const placement = registry.placeClientPage('page-a', attached.browserHostClientId)
    if (placement.kind !== 'client') {
      throw new Error('Expected client browser placement')
    }
    const issued = registry.issueClientPageCommand(
      {
        authorityRuntimeId: attached.authorityRuntimeId,
        authorityEpoch: attached.authorityEpoch,
        browserPageId: 'page-a',
        browserHostClientId: placement.browserHostClientId,
        browserHostGeneration: placement.browserHostGeneration,
        pageHostGeneration: placement.pageHostGeneration
      },
      {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'native:integration'
      }
    )

    await expect(issued.result).resolves.toEqual({ status: 'completed' })
    expect(onPageCommand).toHaveBeenCalledWith(issued.event)
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: attached.connectionId,
        pairedDeviceId: attached.pairedDeviceId
      }),
      expect.objectContaining({ commandId: issued.event.commandId })
    )
    expect(errors).toEqual([])
  })

  it('commits same-runtime reconciliation placement after a real paired command result', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-reconciliation-'))
    resources.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const runtime = new OrcaRuntimeService({} as never)
    const rpc = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      methods: ALL_RPC_METHODS
    })
    await rpc.start()
    resources.push(() => rpc.stop())

    const offer = rpc.createPairingOffer({ name: 'browser-reconciliation', scope: 'runtime' })
    if (!offer.available) {
      throw new Error('Runtime pairing is unavailable')
    }
    const pairing = parsePairingCode(offer.pairingUrl)
    if (!pairing?.pairedDeviceId) {
      throw new Error('Runtime pairing identity is unavailable')
    }
    const oldPage = {
      authorityRuntimeId: runtime.getRuntimeId(),
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'integration-browser-host',
      browserHostGeneration: 4,
      browserPageId: 'page-reclaimed',
      pageHostGeneration: 7,
      browserProfileId: 'default',
      executionHostKey: 'native:integration',
      state: 'active' as const,
      currentUrl: 'https://remote.internal/'
    }
    const onPageCommand = vi.fn(() => Promise.resolve({ status: 'completed' as const }))
    const hostLease = new PairedRuntimeBrowserHostLease({
      pairing,
      authorityRuntimeId: runtime.getRuntimeId(),
      browserHostClientId: 'integration-browser-host',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageReconciliationProtocolVersion: 1,
      getPageInventory: () => [oldPage],
      onPageCommand
    })
    await hostLease.start()
    resources.push(() => hostLease.close())

    const registry = getBrowserHostLeaseRegistry(runtime)
    const attached = registry.select('integration-browser-host')
    const identity = {
      authorityEpoch: attached.authorityEpoch,
      browserHostClientId: attached.browserHostClientId,
      browserHostGeneration: attached.browserHostGeneration,
      pairedDeviceId: attached.pairedDeviceId
    }
    const grant = registry.grantExecutionHost(identity, 'native:integration')
    resources.push(grant.release)
    const adopted = await registry.adoptClientPages(identity, [
      {
        authorityRuntimeId: attached.authorityRuntimeId,
        authorityEpoch: attached.authorityEpoch,
        browserHostClientId: attached.browserHostClientId,
        browserHostGeneration: attached.browserHostGeneration,
        browserPageId: oldPage.browserPageId,
        pageHostGeneration: 8,
        browserProfileId: oldPage.browserProfileId,
        executionHostKey: oldPage.executionHostKey,
        reclaimFrom: { ...oldPage, pairedDeviceId: pairing.pairedDeviceId }
      }
    ])

    expect(adopted).toEqual([oldPage.browserPageId])
    expect(onPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.objectContaining({ type: 'reclaimPage' }) })
    )
    expect(registry.getPlacement(oldPage.browserPageId)).toMatchObject({
      kind: 'client',
      pageHostGeneration: 8
    })
  })

  it('loads an execution-host HTTP target through SOCKS and the dedicated E2EE socket', async () => {
    const destinationSockets = new Set<Socket>()
    const destination = createServer((socket) => {
      destinationSockets.add(socket)
      socket.once('close', () => destinationSockets.delete(socket))
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Length: 25\r\nConnection: keep-alive\r\n\r\nREMOTE_RUNTIME_HTTP_OK\n'
        )
      })
    })
    const destinationAddress = await listen(destination)
    resources.push(() => closeServer(destination))

    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-tunnel-'))
    resources.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const runtime = new OrcaRuntimeService({} as never)
    const rpc = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      methods: ALL_RPC_METHODS
    })
    await rpc.start()
    resources.push(() => rpc.stop())

    const offer = rpc.createPairingOffer({ name: 'browser-tunnel', scope: 'runtime' })
    if (!offer.available) {
      throw new Error('Runtime pairing is unavailable')
    }
    const pairing = parsePairingCode(offer.pairingUrl)
    if (!pairing?.pairedDeviceId) {
      throw new Error('Runtime pairing identity is unavailable')
    }

    const errors: Error[] = []
    const hostLease = new PairedRuntimeBrowserHostLease({
      pairing,
      authorityRuntimeId: runtime.getRuntimeId(),
      browserHostClientId: 'integration-browser-host',
      hostCapabilities: ['webview'],
      onError: (error) => errors.push(error)
    })
    const lease = await hostLease.start()
    resources.push(() => hostLease.close())
    const route = new PairedRuntimeBrowserNetworkRoute({
      pairing,
      lease,
      executionHostRevision: runtime.getStartedAt(),
      onError: (error) => errors.push(error)
    })
    const socksAddress = await route.start()
    resources.push(() => route.close())

    const browserSocket = connect(socksAddress)
    resources.push(() => {
      browserSocket.destroy()
    })
    const responses = collectSocketBytes(browserSocket)
    browserSocket.write(new Uint8Array([5, 1, 0]))
    await vi.waitFor(() => expect(responses.bytes().subarray(0, 2)).toEqual(Buffer.from([5, 0])))
    const host = Buffer.from('127.0.0.1')
    browserSocket.write(
      Buffer.concat([
        Buffer.from([5, 1, 0, 3, host.byteLength]),
        host,
        Buffer.from([destinationAddress.port >> 8, destinationAddress.port & 0xff])
      ])
    )
    await vi.waitFor(() => expect(responses.bytes().byteLength).toBeGreaterThanOrEqual(12))
    expect(responses.bytes().subarray(2, 12)).toEqual(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))

    browserSocket.write('GET / HTTP/1.1\r\nHost: runtime-only.test\r\n\r\n')
    await vi.waitFor(() =>
      expect(responses.bytes().toString('utf8')).toContain('REMOTE_RUNTIME_HTTP_OK')
    )
    expect(errors).toEqual([])
    expect(destinationSockets.size).toBe(1)

    await route.close()
    await vi.waitFor(() => expect(destinationSockets.size).toBe(0))
  })
})

async function listen(server: Server): Promise<{ host: string; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port')
  }
  return { host: '127.0.0.1', port: address.port }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

function collectSocketBytes(socket: Socket): { bytes: () => Buffer } {
  const chunks: Buffer[] = []
  socket.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
  return { bytes: () => Buffer.concat(chunks) }
}
