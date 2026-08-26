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
  /** System-default real-home routing (flag ON): inject no managed CODEX_HOME,
   *  and strip only an inherited Orca-owned override so nested Orca panes do not
   *  leak the parent's managed home. A user-set CODEX_HOME is preserved. */
  stripInheritedOrcaCodexHome?: boolean
  /** Launch command the renderer chose (e.g. 'pi', 'omp', 'claude'); resolves the per-agent
   *  extension target for Pi/OMP. Undefined for bare shells → defaults to Pi. NEVER infer from
   *  disk presence (cross-agent shadowing when both dirs exist). */
  launchCommand?: string
  /** Trusted agent identity for wrapped commands that cannot be recognized from text. */
  launchAgent?: TuiAgent
  isWsl?: boolean
  /** Distro for WSL spawns (null = Windows default distro); drives the WSL hook relay + endpoint repoint. Only read when isWsl. */
  wslDistro?: string | null
  agentStatusHooksEnabled: boolean
  codexStatusHooksEnabled?: boolean
  networkProxySettings?: NetworkProxySettings
  /** Keep indexed Git config off the sparse daemon wire; the daemon appends guard entries after merging its inherited env. */
  deferGitConfigGuardToDaemon?: boolean
}

export type CodexHomeLaunchContext = {
  workspacePath?: string
  launchAgent?: TuiAgent
  unavailableManagedHomePath?: string
}

export type GetSelectedCodexHomePath = (
  target?: CodexAccountSelectionTarget,
  launchEnv?: NodeJS.ProcessEnv,
  launchContext?: CodexHomeLaunchContext
) => string | null

export type PrepareCodexSessionResume = (args: {
  providerSession: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  workspacePath?: string
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
