import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { ownerSurfacing } from './orca-runtime-core'
import type { SpawnIntent } from '../../shared/host-spawn-admission'

export type { TerminalCreateOptions }
export type { Worktree } from '../../shared/worktree/types'
export type { RuntimeTerminalCreate } from '../../shared/runtime-types'
export {
  createTerminalRevealWarning,
  ownerSurfacing,
  resolveTerminalPresentation
} from './orca-runtime-core'
export { makePaneKey } from '../../shared/stable-pane-id'
export { randomUUID } from 'node:crypto'
export {
  admitStablePaneAdoption,
  materializedStablePaneReply,
  allocateTerminalPaneIdentity
} from './runtime-terminal-pane-identity'
export {
  copySleepingAgentLaunchConfig,
  inferCapturedClaudeAgentTeamsMode,
  mergeTerminalEnvDeletionKeys
} from './runtime-agent-launch-resolution'
export { buildClaudeAgentTeamsLaunchPlan } from './claude-agent-teams-shim-env'
export {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess
} from '../../shared/claude-agent-teams-tmux-compat'
export { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
export { getTerminalViewerColors, setPairedViewerColors } from './terminal-view-attribute-store'
export { normalizeColorQueryReplyColors } from '../../shared/pty-owner-color-query-colors'
export type { RuntimePtyController } from './runtime-pty-controller-contract'
export { getRuntimeDesktopSurface } from './runtime-desktop-surface'
export { newTabIn } from './runtime-terminal-spawn-placement'
import type { PaneStartArgs } from './runtime-pane-admission'
export { spawnInAdmittedPane } from './runtime-pane-admission'
export type PaneStartArgsOf = (opts: TerminalCreateOptions) => PaneStartArgs
export type { IpcMainEvent } from 'electron'

// No renderer exists yet; main must answer startup queries or agents such as Muse silently exit.
export const BACKGROUND_TERMINAL_SPAWN_FLAGS = {
  initiallyHidden: true,
  persistHostSessionBinding: true
} as const

export const spawnShellInputs = ({
  shellOverride,
  launchRuntime
}: Pick<TerminalCreateOptions, 'shellOverride' | 'launchRuntime'>) => ({
  ...(shellOverride ? { shellOverride } : {}),
  ...(launchRuntime ? { launchRuntime } : {})
})

/** Abort disconnected callers, refuse sleeping workspaces, and pass fork intent for host validation. */
export function callerSpawnScope(
  opts: Pick<TerminalCreateOptions, 'signal' | 'refuseSleptWorktree' | 'spawnIntent'>
): { signal?: AbortSignal; refuseSleptWorktree?: true; spawnIntent?: SpawnIntent } {
  return {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.refuseSleptWorktree ? { refuseSleptWorktree: true } : {}),
    ...(opts.spawnIntent ? { spawnIntent: opts.spawnIntent } : {})
  }
}

export function terminalRevealViewerOptions(
  opts: Pick<TerminalCreateOptions, 'surfaceOwner' | 'agentLaunchViewer'>
) {
  return {
    ...ownerSurfacing(opts.surfaceOwner !== false),
    ...(opts.agentLaunchViewer ? { agentLaunchViewer: opts.agentLaunchViewer() } : {})
  }
}
