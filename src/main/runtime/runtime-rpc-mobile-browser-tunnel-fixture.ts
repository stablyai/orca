import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import {
  BrowserClientHostCommandEvent,
  type BrowserNetworkExecutionHost
} from '../../shared/browser-client-host-protocol'
import {
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import { decryptBytes, encryptBytes } from './rpc/e2ee-crypto'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { ALL_RPC_METHODS } from './rpc/methods'
import { createBrowserNetworkTunnelMethods } from './rpc/methods/browser-network-tunnel'
import {
  browserNetworkExecutionHostKey,
  type BrowserNetworkExecutionRouteResolver
} from '../browser/browser-network-execution-route'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { createRuntimeBrowserClientPage } from './runtime-browser-client-page-creation'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'

export const mobileTunnelCapabilities = [
  'browser.clientHost.v1',
  'browser.clientHost.mobileLease.v1',
  'browser.clientHost.mobileTunnel.v1',
  'network.browserTunnel.v1',
  'network.browserTunnel.executionHosts.v1'
]

export async function mobileBrowserTunnelFixture(
  resolveRoute?: BrowserNetworkExecutionRouteResolver
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-mobile-tunnel-'))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: directory,
    enableWebSocket: true,
    wsPort: 0,
    ...(resolveRoute
      ? {
          methods: [
            ...ALL_RPC_METHODS.filter((method) => method.name !== 'network.browserTunnel'),
            ...createBrowserNetworkTunnelMethods(undefined, resolveRoute)
          ]
        }
      : {})
  })
  await server.start()
  const cleanups: (() => Promise<void>)[] = []
  let sequence = 0
  async function connect(pairingUrl?: string, capabilities = mobileTunnelCapabilities) {
    const offer = pairingUrl
      ? undefined
      : server.createPairingOffer({ address: '127.0.0.1', name: 'fixture phone', scope: 'mobile' })
    const url = pairingUrl ?? (offer?.available ? offer.pairingUrl : '')
    const session = await authenticateMobileWsSession(url)
    const reader = createEncryptedWsResponseReader(session)
    const frames: BrowserNetworkTunnelFrame[] = []
    session.ws.on('message', (data, isBinary) => {
      if (!isBinary || !Buffer.isBuffer(data)) {
        return
      }
      const bytes = decryptBytes(data, session.sharedKey)
      const frame = bytes && decodeBrowserNetworkTunnelFrame(bytes)
      if (frame) {
        frames.push(frame)
      }
    })
    cleanups.push(async () => {
      reader.dispose()
      session.ws.close()
      await waitForWsClose(session.ws)
    })
    const send = (method: string, params: unknown) => {
      const id = `mobile-${++sequence}`
      sendEncryptedWsRequest(session, { id, method, params })
      return id
    }
    const call = (method: string, params: unknown) => reader.next(send(method, params))
    expect(
      await call('runtime.clientCapabilities.update', { clientCapabilities: capabilities })
    ).toMatchObject({ ok: true })
    return {
      session,
      reader,
      frames,
      url,
      send,
      call,
      binary: (frame: BrowserNetworkTunnelFrame) =>
        session.ws.send(encryptBytes(encodeBrowserNetworkTunnelFrame(frame), session.sharedKey))
    }
  }
  const registry = getBrowserHostLeaseRegistry(runtime)
  const native: BrowserNetworkExecutionHost = {
    kind: 'native',
    runtimeId: runtime.getRuntimeId(),
    revision: runtime.getStartedAt()
  }
  async function host(reconnect = false) {
    const peer = await connect()
    const browserHostClientId = `phone-host-${++sequence}`
    const attach = peer.send('browser.clientHost.attach', {
      authorityRuntimeId: runtime.getRuntimeId(),
      browserHostClientId,
      hostCapabilities: ['webview', 'automation-v1'],
      supportedAutomationMethods: ['browser.snapshot'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageReconciliationProtocolVersion: 1,
      ...(reconnect ? { leaseReconnectProtocolVersion: 1 } : {}),
      pageInventory: []
    })
    expect(await peer.reader.next(attach)).toMatchObject({ ok: true, result: { type: 'ready' } })
    const lease = registry.select(browserHostClientId)
    const params = (executionHost = native) => ({ ...lease, executionHost })
    async function page(executionHost = native) {
      const browserPageId = `page-${++sequence}`
      const pending = createRuntimeBrowserClientPage(registry, {
        browserPageId,
        browserHostClientId,
        pairedDeviceId: lease.pairedDeviceId,
        browserProfileId: 'default',
        executionHost,
        workspaceId: 'folder:fixture'
      })
      const event = BrowserClientHostCommandEvent.parse((await peer.reader.next(attach)).result)
      expect(event.command).toMatchObject({ type: 'createPage', workspaceId: 'folder:fixture' })
      expect(
        await peer.call('browser.clientHost.commandResult', {
          ...event,
          result: { status: 'completed' }
        })
      ).toMatchObject({ ok: true })
      const created = await pending
      getRuntimeBrowserPageRegistry(runtime).publishClientPage({
        browserPageId,
        workspaceId: 'folder:fixture',
        browserProfileId: 'default',
        executionHostKey: browserNetworkExecutionHostKey(executionHost),
        placement: created.placement,
        pairedDeviceId: lease.pairedDeviceId,
        url: 'about:blank',
        loading: false,
        active: false
      })
      return {
        ...created,
        retire: () =>
          registry.completePageRetirement(
            registry.beginPageRetirement(browserPageId, created.placement)
          )
      }
    }
    return { peer, lease, attach, params, page }
  }
  return {
    runtime,
    server,
    registry,
    native,
    connect,
    host,
    close: async () => {
      for (const cleanup of cleanups.toReversed()) {
        await cleanup()
      }
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
