import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type * as HostProtocolGatesModule from '../components/host-protocol-gates-context'
import type * as RpcOperationModule from '../transport/rpc-operation'

import { vi } from 'vitest'

// Mobile protocol doubles; host-backed joins own their disk and Electron seams.
export type Doubles = {
  connection: { client: object | null; state: string }
  gates: {
    statusPending: boolean
    statusReadable: boolean
    hostCapabilities: string[]
    hostProtocolWindow: { protocolVersion: number; minCompatibleMobileVersion: number }
  }
  manifest: MobileWebBundleManifestRead | null
  fetch: () => Promise<MobileWebBundleFetchResult>
}

const doubles = vi.hoisted((): Doubles => ({
  connection: { client: {}, state: 'connected' },
  gates: {
    statusPending: false,
    statusReadable: true,
    hostCapabilities: [],
    hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
  },
  manifest: null,
  fetch: () => Promise.reject(new Error('no fetch staged'))
}))

vi.mock('expo-crypto', async () => {
  const { randomBytes } = await import('node:crypto')
  return { getRandomBytes: (length: number) => new Uint8Array(randomBytes(length)) }
})
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../transport/mobile-endpoint-supervisor-support', () => ({
  encodeBase64Url: () => 'session-id'
}))
vi.mock('../components/host-protocol-gates-context', async (importOriginal) => {
  const actual = await importOriginal<typeof HostProtocolGatesModule>()
  return {
    ...actual,
    useHostProtocolGates: () => actual.useOptionalHostProtocolGates() ?? doubles.gates
  }
})
vi.mock('../transport/host-client-hooks', () => ({ useHostClient: () => doubles.connection }))
vi.mock('../transport/rpc-operation', async (importOriginal) => {
  const actual = await importOriginal<typeof RpcOperationModule>()
  return {
    ...actual,
    runRpcOperation: async (...args: Parameters<typeof actual.runRpcOperation>) => {
      if (args[1].name !== 'mobileWeb.bundle-manifest') {
        return actual.runRpcOperation(...args)
      }
      if (doubles.manifest === null) {
        throw new Error('the test reached the host with no manifest staged')
      }
      return { manifest: doubles.manifest }
    }
  }
})
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => doubles.fetch()
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios', select: (v: { ios?: unknown }) => v.ios },
  StyleSheet: { create: <T>(v: T) => v, hairlineWidth: 1 },
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Switch: 'Switch',
  InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) }
}))
vi.mock('lucide-react-native', () => new Proxy({}, { get: (_t, key) => key, has: () => true }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {}
}))
vi.mock('../transport/host-app-version-store', () => ({ recordHostAppVersion: async () => {} }))
vi.mock('../transport/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: () => {}
}))
vi.mock('../components/AutoHeight', () => ({ AutoHeight: 'AutoHeight' }))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))

export { doubles }
