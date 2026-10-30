import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { NetworkProxySettings } from '../../../../shared/network-proxy'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from '../../../claude-accounts/runtime-selection'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import type { CodexPaneHomeRoute } from '../../../codex/codex-pane-account-registry'
import type { CodexSessionResumePreparation } from '../../../codex/codex-session-resume-home'

export type BuildPtyHostEnvOptions = {
  isPackaged: boolean
  resourcesPath?: string
  userDataPath: string
  selectedCodexHomePath: string | null
  skipCodexHomeEnv?: boolean
  /** Real-home routing strips only inherited Orca-owned Codex overrides, preserving user CODEX_HOME. */
  stripInheritedOrcaCodexHome?: boolean
  /** Explicit launch command selects Pi/OMP extension targets; never infer agent identity from directories on disk. */
  launchCommand?: string
  /** Trusted agent identity for wrapped commands that cannot be recognized from text. */
  launchAgent?: TuiAgent
  /** Selected execution shell, which may differ from inherited SHELL. */
  shellPath?: string
  isWsl?: boolean
  /** WSL relay target; null selects the default distro. Read only for WSL spawns. */
  wslDistro?: string | null
  agentStatusHooksEnabled: boolean
  claudeSubagentNavigationEnabled?: boolean
  terminalInlineImages?: boolean
  /** Per-agent opt-out; disabled agents must not receive managed extensions. */
  disabledTuiAgents?: Iterable<unknown> | null
  networkProxySettings?: NetworkProxySettings
  /** Headless paired runtimes hand browser launches to the client-hosted Orca browser. */
  routeBrowserOpensToClient?: boolean
  /** Keep indexed Git config off the sparse daemon wire; the daemon appends guard entries after merging its inherited env. */
  deferGitConfigGuardToDaemon?: boolean
}

export type CodexHomeLaunchContext = {
  unavailableManagedHomePath?: string
  launchesCodex?: boolean
}

// Codex hook-trust preparation may await app-server I/O without blocking main (#16441).
export type GetSelectedCodexHomePath = (
  target?: CodexAccountSelectionTarget,
  launchEnv?: NodeJS.ProcessEnv,
  launchContext?: CodexHomeLaunchContext
) => string | null | Promise<string | null>

export type PrepareCodexSessionResume = (args: {
  providerSession: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  useSelectedAccount?: boolean
}) => Promise<CodexSessionResumePreparation | null>

export type CodexHomePtySpawnedLifecycleArgs = {
  id: string
  codexHomePath: string | null
  reattached?: boolean
  reattachedHomeRoute?: CodexPaneHomeRoute | null
  launchEnv?: NodeJS.ProcessEnv
  startedAt?: Date
  startedSequence?: number
}

let ptyLifecycleSequence = 0

export function allocatePtyLifecycleSequence(): number {
  return ++ptyLifecycleSequence
}

export type PrepareClaudeAuth = (
  target?: ClaudeAccountSelectionTarget
) => Promise<ClaudeRuntimeAuthPreparation>
