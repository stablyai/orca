import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebAgentHistoryAuthority } from './mobile-web-agent-history-authority'
import { MobileWebAgentHistoryPager } from './mobile-web-agent-history-pager'
import { MobileWebAgentHistoryResume } from './mobile-web-agent-history-resume'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebSourceControlBranchComparePager } from './mobile-web-source-control-branch-compare-pager'
import { MobileWebTerminalArtifactAuthority } from './mobile-web-terminal-artifact-authority'
import { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'
import { MobileWebTaskProjectTablePager } from './mobile-web-task-project-table-pager'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebWorkspaceSnapshotPager } from './mobile-web-workspace-snapshot-pager'

export class MobileWebCapabilityAuthorities {
  readonly agentHistory: MobileWebAgentHistoryAuthority
  readonly agentHistoryPager: MobileWebAgentHistoryPager
  readonly agentHistoryResume: MobileWebAgentHistoryResume
  readonly browser: MobileWebBrowserAuthority
  readonly nativeChat: MobileWebNativeChatAuthority
  readonly sourceControlBranchCompare: MobileWebSourceControlBranchComparePager
  readonly terminalArtifact: MobileWebTerminalArtifactAuthority
  readonly taskTarget: MobileWebTaskTargetAuthority
  readonly taskProjectTable: MobileWebTaskProjectTablePager
  readonly workspace: MobileWebWorkspaceAuthority
  readonly workspaceSnapshots: MobileWebWorkspaceSnapshotPager

  constructor(options: { now?: () => number; randomBytes: (length: number) => Uint8Array }) {
    this.agentHistory = new MobileWebAgentHistoryAuthority(options.randomBytes)
    this.agentHistoryPager = new MobileWebAgentHistoryPager(options.randomBytes)
    this.agentHistoryResume = new MobileWebAgentHistoryResume(options.randomBytes)
    this.browser = new MobileWebBrowserAuthority(options.randomBytes)
    this.nativeChat = new MobileWebNativeChatAuthority(options.randomBytes)
    this.sourceControlBranchCompare = new MobileWebSourceControlBranchComparePager()
    this.terminalArtifact = new MobileWebTerminalArtifactAuthority(options)
    this.taskTarget = new MobileWebTaskTargetAuthority(options.randomBytes)
    this.taskProjectTable = new MobileWebTaskProjectTablePager(options.randomBytes)
    this.workspace = new MobileWebWorkspaceAuthority(options.randomBytes)
    this.workspaceSnapshots = new MobileWebWorkspaceSnapshotPager(options.randomBytes)
  }

  clear(): void {
    this.agentHistory.clear()
    this.agentHistoryPager.clear()
    this.agentHistoryResume.clear()
    this.browser.clear()
    this.nativeChat.clear()
    this.sourceControlBranchCompare.clear()
    this.terminalArtifact.clear()
    this.taskTarget.clear()
    this.taskProjectTable.clear()
    this.workspace.clear()
    this.workspaceSnapshots.clear()
  }
}
