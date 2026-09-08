import type { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebCommitMessageGeneration } from './mobile-web-commit-message-generation'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
import type { MobileWebTerminalStreams } from './mobile-web-terminal-streams'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import type { MobileWebWorkspaceSnapshotPager } from './mobile-web-workspace-snapshot-pager'

type PageRequest = Extract<MobileWebBridgePageMessage, { type: 'request' }>

export type MobileWebCapabilityExecutionDependencies = {
  request: PageRequest
  isRequestActive: () => boolean
  connectedClient: () => RpcClient
  terminalClientId: string
  nativeAuthority: MobileWebNativeCapabilityAuthority
  hostSubscriptions: MobileWebHostSubscriptions
  speechAuthority: MobileWebSpeechAuthority
  terminalStreams: MobileWebTerminalStreams
  commitMessageGeneration: MobileWebCommitMessageGeneration
  nativeChatAuthority: MobileWebNativeChatAuthority
  workspaceAuthority: MobileWebWorkspaceAuthority
  workspaceSnapshots: MobileWebWorkspaceSnapshotPager
  navigationAuthority?: MobileWebNavigationAuthority
}
