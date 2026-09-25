import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { OrcaRuntimeService } from './orca-runtime'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from './rpc/methods/runtime-client-capabilities'
import {
  type AuthenticatedMobileWs,
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'

const capabilities = [
  'browser.clientHost.v1',
  'browser.clientHost.pageMetadata.v1',
  'browser.clientHost.mobileLease.v1'
]

describe('authenticated mobile browser lease over runtime RPC', () => {
  let directory: string
  let runtime: OrcaRuntimeService
  let server: OrcaRuntimeRpcServer
  const peers: {
    session: AuthenticatedMobileWs
    reader: ReturnType<typeof createEncryptedWsResponseReader>
  }[] = []
  let sequence = 0

  async function connect(pairingUrl?: string) {
    const offer = pairingUrl
      ? undefined
      : server.createPairingOffer({
          address: '127.0.0.1',
          name: 'synthetic phone',
          scope: 'mobile'
        })
    if (!pairingUrl && !offer?.available) {
      throw new Error('pairing unavailable')
    }
    const url = pairingUrl ?? (offer?.available ? offer.pairingUrl : '')
    const session = await authenticateMobileWsSession(url)
    const reader = createEncryptedWsResponseReader(session)
    const send = (method: string, params: unknown) => {
      const id = `request-${++sequence}`
      sendEncryptedWsRequest(session, { id, method, params })
      return id
    }
    const peer = {
      session,
      reader,
      url,
      send,
      call: (method: string, params: unknown) => reader.next(send(method, params))
    }
    peers.push(peer)
    return peer
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-mobile-browser-lease-'))
    runtime = new OrcaRuntimeService()
    server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: directory,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
  })

  afterEach(async () => {
    for (const peer of peers.splice(0)) {
      peer.reader.dispose()
      peer.session.ws.close()
      await waitForWsClose(peer.session.ws)
    }
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
  })

  function attachParams() {
    return {
      authorityRuntimeId: runtime.getRuntimeId(),
      browserHostClientId: 'phone-host',
      hostCapabilities: ['webview', 'automation-v1'],
      supportedAutomationMethods: ['browser.snapshot'],
      pageCommandProtocolVersion: 1
    }
  }

  it('roundtrips only negotiated commands and metadata with exact connection authority', async () => {
    const phone = await connect()
    expect(
      await phone.call('runtime.clientCapabilities.update', { clientCapabilities: capabilities })
    ).toMatchObject({ ok: true })
    const attach = phone.send('browser.clientHost.attach', attachParams())
    expect(await phone.reader.next(attach)).toMatchObject({
      ok: true,
      result: { type: 'ready', supportedAutomationMethods: ['browser.snapshot'] }
    })
    const registry = getBrowserHostLeaseRegistry(runtime)
    const lease = registry.select('phone-host')
    expect(lease).toMatchObject({ clientKind: 'mobile' })
    expect(() => registry.select(undefined, ['webview', 'automation-v1'])).toThrow(
      'browser_host_unavailable'
    )
    const placement = registry.placeClientPage('page-phone', 'phone-host')
    if (placement.kind !== 'client') {
      throw new Error('client placement required')
    }
    const pages = getRuntimeBrowserPageRegistry(runtime)
    pages.publishClientPage({
      browserPageId: 'page-phone',
      workspaceId: 'folder-workspace',
      browserProfileId: 'default',
      executionHostKey: 'ssh:test:1',
      placement,
      url: 'about:blank',
      loading: false,
      active: true
    })
    const authority = {
      ...placement,
      authorityRuntimeId: lease.authorityRuntimeId,
      authorityEpoch: lease.authorityEpoch,
      browserPageId: 'page-phone'
    }
    registry.grantExecutionHost(lease, 'ssh:test:1')
    const created = registry.issueClientPageCommand(authority, {
      type: 'createPage',
      browserProfileId: 'default',
      executionHostKey: 'ssh:test:1'
    })
    const createFrame = await phone.reader.next(attach)
    const createEvent = BrowserClientHostCommandEvent.parse(createFrame.result)
    expect(
      await phone.call('browser.clientHost.commandResult', {
        ...createEvent,
        result: { status: 'completed' }
      })
    ).toMatchObject({ ok: true })
    await expect(created.result).resolves.toEqual({ status: 'completed' })
    expect(() =>
      registry.issueClientPageCommand(authority, {
        type: 'automation',
        method: 'browser.click',
        params: {}
      })
    ).toThrow('browser_client_automation_method_unsupported')
    const issued = registry.issueClientPageCommand(authority, {
      type: 'automation',
      method: 'browser.snapshot',
      params: {}
    })
    const frame = await phone.reader.next(attach)
    const event = BrowserClientHostCommandEvent.parse(frame.result)
    expect(event.command).toEqual({ type: 'automation', method: 'browser.snapshot', params: {} })
    const result = {
      ...event,
      result: { status: 'completed', value: { snapshot: 'phone document' } }
    }
    const otherDevice = await connect()
    const otherConnection = await connect(phone.url)
    for (const peer of [otherDevice, otherConnection]) {
      await peer.call('runtime.clientCapabilities.update', { clientCapabilities: capabilities })
      expect(await peer.call('browser.clientHost.commandResult', result)).toMatchObject({
        ok: false
      })
    }
    for (const override of [
      { browserHostClientId: 'other-host' },
      { browserHostGeneration: lease.browserHostGeneration + 1 },
      { authorityRuntimeId: 'other-runtime' },
      { authorityEpoch: 'old-epoch' },
      { pageHostGeneration: placement.pageHostGeneration + 1 }
    ]) {
      expect(
        await phone.call('browser.clientHost.commandResult', { ...result, ...override })
      ).toMatchObject({ ok: false })
    }
    expect(await phone.call('browser.clientHost.commandResult', result)).toMatchObject({
      ok: true,
      result: { accepted: true }
    })
    await expect(issued.result).resolves.toEqual(result.result)
    const metadata = {
      ...placement,
      browserPageId: 'page-phone',
      revision: 1,
      url: 'https://example.test',
      title: 'Phone page',
      loading: false,
      canGoBack: false,
      canGoForward: false
    }
    for (const override of [
      { browserHostClientId: 'other-host' },
      { browserHostGeneration: lease.browserHostGeneration + 1 },
      { pageHostGeneration: placement.pageHostGeneration + 1 }
    ]) {
      expect(
        await phone.call('browser.clientHost.pageMetadata', { ...metadata, ...override })
      ).toMatchObject({ ok: false })
    }
    for (const peer of [otherDevice, otherConnection]) {
      expect(await peer.call('browser.clientHost.pageMetadata', metadata)).toMatchObject({
        ok: false
      })
    }
    expect(pages.getPage('page-phone')?.url).toBe('about:blank')
    expect(await phone.call('browser.clientHost.pageMetadata', metadata)).toMatchObject({
      ok: true,
      result: { accepted: true }
    })
    expect(pages.getPage('page-phone')).toMatchObject({ title: 'Phone page', placement })
    const desktop = registry.attach({
      browserHostClientId: 'desktop-a',
      connectionId: 'desktop-connection-a',
      pairedDeviceId: 'desktop-device-a',
      hostCapabilities: ['webview', 'automation-v1']
    })
    expect(registry.select(undefined, ['webview', 'automation-v1']).browserHostClientId).toBe(
      'desktop-a'
    )
    const desktopB = registry.attach({
      browserHostClientId: 'desktop-b',
      connectionId: 'desktop-connection-b',
      pairedDeviceId: 'desktop-device-b',
      hostCapabilities: ['webview', 'automation-v1']
    })
    expect(() => registry.select(undefined, ['webview', 'automation-v1'])).toThrow(
      'browser_host_ambiguous'
    )
    expect(registry.getPlacement('page-phone')).toEqual(placement)
    desktop.release()
    desktopB.release()
  })

  it('requires opt-in, exact runtime, explicit methods and keeps network/file channels closed', async () => {
    const phone = await connect()
    for (const method of [
      'browser.clientHost.attach',
      'browser.clientHost.commandResult',
      'browser.clientHost.pageMetadata'
    ]) {
      expect(
        await phone.call(method, {
          ...attachParams(),
          clientCapabilities: capabilities,
          clientKind: 'runtime'
        })
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    await phone.call('runtime.clientCapabilities.update', { clientCapabilities: capabilities })
    for (const override of [
      { supportedAutomationMethods: undefined },
      { pageCommandProtocolVersion: undefined },
      { fileChannelProtocolVersion: 1 },
      { authorityRuntimeId: 'wrong-runtime' }
    ]) {
      expect(
        await phone.call('browser.clientHost.attach', { ...attachParams(), ...override })
      ).toMatchObject({ ok: false })
      expect(() => getBrowserHostLeaseRegistry(runtime).select('phone-host')).toThrow(
        'browser_host_unavailable'
      )
    }
    for (const method of [
      'network.browserTunnel',
      'browser.clientHost.fileChannel.read',
      'browser.clientHost.fileChannel.write',
      'browser.clientHost.fileChannel.abort'
    ]) {
      expect(await phone.call(method, {})).toMatchObject({
        ok: false,
        error: { code: 'forbidden' }
      })
    }
    expect(await phone.call('status.get', {})).toMatchObject({
      ok: true,
      result: { deviceScope: 'mobile' }
    })
    const attached = phone.send('browser.clientHost.attach', attachParams())
    expect(await phone.reader.next(attached)).toMatchObject({ ok: true })
    const intruder = await connect()
    await intruder.call('runtime.clientCapabilities.update', { clientCapabilities: capabilities })
    expect(await intruder.call('browser.clientHost.attach', attachParams())).toMatchObject({
      ok: false,
      error: { message: 'browser_host_identity_conflict' }
    })
    expect(getBrowserHostLeaseRegistry(runtime).select('phone-host').clientKind).toBe('mobile')
  })

  it('retains authenticated mobile scope across same-generation reconnect', async () => {
    const phone = await connect()
    await phone.call('runtime.clientCapabilities.update', { clientCapabilities: capabilities })
    const params = {
      ...attachParams(),
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      leaseReconnectProtocolVersion: 1
    }
    const attach = phone.send('browser.clientHost.attach', params)
    expect(await phone.reader.next(attach)).toMatchObject({ ok: true })
    const registry = getBrowserHostLeaseRegistry(runtime)
    const original = registry.select('phone-host')
    const replacement = await connect(phone.url)
    await replacement.call('runtime.clientCapabilities.update', {
      clientCapabilities: capabilities
    })
    const next = replacement.send('browser.clientHost.attach', params)
    expect(await replacement.reader.next(next)).toMatchObject({
      ok: true,
      result: { browserHostGeneration: original.browserHostGeneration }
    })
    const current = registry.select('phone-host')
    expect(current.connectionId).not.toBe(original.connectionId)
    expect(current.clientKind).toBe('mobile')
    expect(() => registry.select()).toThrow('browser_host_unavailable')
    expect(() =>
      registry.attach({
        ...params,
        pairedDeviceId: current.pairedDeviceId,
        connectionId: 'runtime-spoof',
        clientKind: 'runtime',
        supportedAutomationMethods: ['browser.snapshot'],
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        leaseReconnectProtocolVersion: 1
      })
    ).toThrow('browser_host_identity_conflict')
    expect(registry.select('phone-host')).toBe(current)
  })

  it('keeps absent-method and authorization refusals explicit during mixed-version probing', async () => {
    await server.stop()
    server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: directory,
      enableWebSocket: true,
      wsPort: 0,
      methods: RUNTIME_CLIENT_CAPABILITY_METHODS
    })
    await server.start()
    const phone = await connect()
    expect(await phone.call('browser.clientHost.attach', attachParams())).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    await phone.call('runtime.clientCapabilities.update', { clientCapabilities: capabilities })
    expect(await phone.call('browser.clientHost.attach', attachParams())).toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
    const id = 'wrong-credential'
    sendEncryptedWsRequest(phone.session, {
      id,
      method: 'browser.clientHost.attach',
      params: attachParams(),
      deviceToken: 'not-the-authenticated-token'
    })
    expect(await phone.reader.next(id)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' }
    })
  })
})
