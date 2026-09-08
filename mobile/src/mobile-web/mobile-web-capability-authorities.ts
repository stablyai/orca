import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebWorkspaceSnapshotPager } from './mobile-web-workspace-snapshot-pager'

export class MobileWebCapabilityAuthorities {
  readonly nativeChat: MobileWebNativeChatAuthority
  readonly workspace: MobileWebWorkspaceAuthority
  readonly workspaceSnapshots: MobileWebWorkspaceSnapshotPager

  constructor(options: { now?: () => number; randomBytes: (length: number) => Uint8Array }) {
    this.nativeChat = new MobileWebNativeChatAuthority(options.randomBytes)
    this.workspace = new MobileWebWorkspaceAuthority(options.randomBytes)
    this.workspaceSnapshots = new MobileWebWorkspaceSnapshotPager(options.randomBytes)
  }

  clear(): void {
    this.nativeChat.clear()
    this.workspace.clear()
    this.workspaceSnapshots.clear()
  }
}
