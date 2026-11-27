import type { ZCodeInteractiveCapability } from '../../../shared/agent-launch/installation/zcode-missing-tui'
import type {
  PreparedAgentLaunch,
  QueuedAgentLaunch
} from '../../../shared/agent-launch/startup/queued-agent-launch'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/execution-host/project-execution-runtime'
import type {
  PathSource,
  ShellHydrationFailureReason
} from '../../../shared/shell/launch/shell-path-hydration-types'

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
  /** Absent on payloads predating GitLab support. */
  glab?: { installed: boolean; authenticated: boolean }
  bitbucket?: { configured: boolean; authenticated: boolean; account: string | null }
  azureDevOps?: {
    configured: boolean
    authenticated: boolean
    account: string | null
    baseUrl: string | null
    tokenConfigured: boolean
  }
  gitea?: {
    configured: boolean
    authenticated: boolean
    account: string | null
    baseUrl: string | null
    tokenConfigured: boolean
  }
}

export type AgentDetectionArgs = PreflightRuntimeContext & {
  enabledOnly?: boolean
  wakeWslDistro?: boolean
  userInitiated?: boolean
  afterPublication?: number
}

export type AgentInventoryReply = {
  agents: string[]
  incomplete?: boolean
  afterPublication?: number
  managedAgentCommands?: Record<string, string>
  outsidePath?: Record<string, string>
}

export type RefreshAgentsResult = AgentInventoryReply & {
  addedPathSegments: string[]
  shellHydrationOk: boolean
  /** shell_hydrate uses the full shell PATH; sync_seed_only uses the packaged PATH seed. */
  pathSource: PathSource
  pathFailureReason: ShellHydrationFailureReason
}

export type PreflightRuntimeContext = {
  wslDistro?: string | null
  wslDefault?: boolean
  projectRuntime?: ProjectExecutionRuntimeResolution
}

export type PreflightApi = {
  check: (
    args?: PreflightRuntimeContext & { force?: boolean; wakeWslDistro?: boolean }
  ) => Promise<PreflightStatus>
  /** Complete by default; background callers opt into host-owned enabled preferences.
   *  `withManagedAgentCommands` adds user CLI paths found outside PATH. */
  detectAgents: {
    (args: { launch: QueuedAgentLaunch }): Promise<PreparedAgentLaunch>
    (args: AgentDetectionArgs & { withManagedAgentCommands: true }): Promise<AgentInventoryReply>
    (args?: AgentDetectionArgs): Promise<string[]>
  }
  /** A WSL distro a background check was refused for is running now; re-ask. Desktop only. */
  onWslDistroRunning?: (callback: (distro: string) => void) => () => void
  /** Cached in main for the process lifetime. */
  zcodeInteractiveCapability: () => Promise<ZCodeInteractiveCapability>
  /** `wakeWslDistro`: a user act that may start a stopped WSL distro; background refreshes omit it. */
  refreshAgents: (
    args?: AgentDetectionArgs & { withManagedAgentCommands?: boolean }
  ) => Promise<RefreshAgentsResult>
  detectRemoteAgents: (args: { connectionId: string }) => Promise<string[]>
  detectRemoteWindowsTerminalCapabilities: (args: { connectionId: string }) => Promise<{
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }>
}
