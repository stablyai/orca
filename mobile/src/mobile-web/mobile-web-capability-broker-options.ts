import type {
  MobileWebBridgeMessageContext,
  MobileWebBridgeShellMessage,
  MobileWebResumeRoute
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'
import type {
  MobileWebTerminalFlowMetrics,
  MobileWebTerminalResyncReason
} from './mobile-web-diagnostics-store'

export type MobileWebHostResumeRoute =
  | { kind: 'workspaceList' }
  | { kind: 'session'; hostWorkspaceId: string }

export type MobileWebCapabilityBrokerOptions = {
  context: MobileWebBridgeMessageContext
  getClient: () => RpcClient | null
  isConnected: () => boolean
  isActive: () => boolean
  postMessage: (message: MobileWebBridgeShellMessage) => void | Promise<void>
  nativeAuthority: MobileWebNativeCapabilityAuthority
  navigationAuthority?: MobileWebNavigationAuthority
  rememberRoute?: (route: MobileWebResumeRoute) => void
  rememberHostRoute?: (route: MobileWebHostResumeRoute) => void
  terminalClientId: string
  onTerminalFlowMetrics?: (metrics: MobileWebTerminalFlowMetrics) => void
  onTerminalResync?: (reason: MobileWebTerminalResyncReason) => void
  now?: () => number
  randomBytes: (length: number) => Uint8Array
}
