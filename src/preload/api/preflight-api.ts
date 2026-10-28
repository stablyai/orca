import type { ZCodeInteractiveCapability } from '../../shared/zcode-missing-tui'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type {
  PathSource,
  ShellHydrationFailureReason
} from '../../shared/shell-path-hydration-types'

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

export type RefreshAgentsResult = {
  agents: string[]
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
  check: (args?: PreflightRuntimeContext & { force?: boolean }) => Promise<PreflightStatus>
  /** Complete by default; background callers opt into host-owned enabled preferences. */
  detectAgents: (args?: PreflightRuntimeContext & { enabledOnly?: boolean }) => Promise<string[]>
  /** Cached in main for the process lifetime. */
  zcodeInteractiveCapability: () => Promise<ZCodeInteractiveCapability>
  refreshAgents: (
    args?: PreflightRuntimeContext & { enabledOnly?: boolean }
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
