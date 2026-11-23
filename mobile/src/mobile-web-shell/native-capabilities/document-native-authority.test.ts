import { expect, it } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '../bridge/protocol/bridge-frame-fields'
import type { BridgeHostDiagnostic, BridgeHostOptions } from '../host-bridge/bridge-host-contract'
import { createBridgeNotifyForwarder } from '../host-streams/bridge-host-notify'
import { createFakeRpcClient } from '../test-support/bridge-host-test-fakes'
import { createDocumentNativeAuthority } from './document-native-authority'

const HOST_ID = 'host-a'
const KEY = 'orca:terminalTextScale'
const noop = (): void => {}

// Drive a real one-way storage notification from the old document through the forwarder's receipt.
function oldDocument() {
  // The live host entries, keyed like the connection store's getClientId lookup.
  const live = new Map<string, string>([[HOST_ID, 'token-a']])
  // The document mounted under token-a and keeps that key until its remount.
  const authority = createDocumentNativeAuthority(
    HOST_ID,
    'token-a',
    (hostId) => live.get(hostId) ?? null
  )
  const written: { key: string; value: string | null }[] = []
  const diagnostics: BridgeHostDiagnostic[] = []
  const options: BridgeHostOptions = {
    client: createFakeRpcClient(),
    post: () => Promise.resolve(),
    buildId: 'build-a',
    sessionId: 'session-a',
    route: { pathname: '/settings' },
    pageRoutes: ['/settings'],
    routeGrants: ['storage'],
    sessionEstablished: true,
    host: { id: HOST_ID, name: 'Host A', endpoint: 'ws://host-a', lastConnected: 0 },
    readClientIdentity: () => 'token-a',
    readStorage: () => ({ storage: {}, storageOversize: [] }),
    onStorageWrite: authority.fenceStorageWrite((key, value) => written.push({ key, value })),
    onNavigate: noop,
    serveNativeVerb: () => Promise.resolve(null),
    onExternalLink: noop,
    onHaptic: noop,
    onNavigateBack: () => 'popped',
    onPageFault: noop,
    onPageReady: noop,
    onPagePainted: noop,
    onPageBackClaim: noop,
    onPageLocation: noop,
    onRouteParamClear: noop,
    onRouteRefused: noop,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  }
  const notify = createBridgeNotifyForwarder({
    options,
    granted: ['storage'],
    initSent: () => true,
    route: () => ({ pathname: '/settings' }),
    onBackClaim: noop,
    onTerminalKeyRailClaim: noop
  })
  const write = (value: string) =>
    notify({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'storage', key: KEY, value })
  return { live, write, written, diagnostics }
}

it('drops the old document write after the live entry disappears, before the remount', () => {
  const doc = oldDocument()
  doc.live.delete(HOST_ID)
  doc.write('2')
  expect(doc.written).toEqual([])
  expect(doc.diagnostics).toEqual([])
})

it('drops the old document write once a replacement credential is live, before the remount', () => {
  const doc = oldDocument()
  doc.live.set(HOST_ID, 'token-b')
  doc.write('2')
  expect(doc.written).toEqual([])
  expect(doc.diagnostics).toEqual([])
})

it('accepts the old document write after the same credential reopens', () => {
  const doc = oldDocument()
  doc.write('1')
  doc.live.delete(HOST_ID)
  doc.write('2')
  doc.live.set(HOST_ID, 'token-a')
  doc.write('3')
  expect(doc.written).toEqual([
    { key: KEY, value: '1' },
    { key: KEY, value: '3' }
  ])
})
