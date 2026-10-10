import type { TerminalCreateOptions } from './runtime-terminal-contracts'

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
export { runtimeNewTabPlacement } from './runtime-terminal-spawn-placement'
export type { IpcMainEvent } from 'electron'

// Why initiallyHidden: no renderer pane exists yet, so main must answer startup queries — Muse
// exits silently when its startup cursor-position query goes unanswered.
export const BACKGROUND_TERMINAL_SPAWN_FLAGS = {
  initiallyHidden: true,
  persistHostSessionBinding: true
} as const

/** Caller-scoped spawn guards: abort when the caller disconnects; never wake a slept worktree. */
export function callerSpawnGuards(
  opts: Pick<TerminalCreateOptions, 'signal' | 'refuseSleptWorktree'>
): { signal?: AbortSignal; refuseSleptWorktree?: true } {
  return {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.refuseSleptWorktree ? { refuseSleptWorktree: true } : {})
  }
}
