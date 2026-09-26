export type { TerminalCreateOptions } from './runtime-terminal-contracts'
export type { RuntimeTerminalCreate } from '../../shared/runtime-types'
export {
  createTerminalRevealWarning,
  ownerSurfacing,
  resolveTerminalPresentation
} from './orca-runtime-core'
export { isValidHostTerminalTabId } from '../../shared/terminal-tab-id'
export { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
export { randomUUID } from 'node:crypto'
export { admitStablePaneAdoption } from './runtime-terminal-pane-identity'
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
export { getTerminalViewColorQueryReplyColors } from './terminal-view-attribute-store'
export type { RuntimePtyController } from './runtime-pty-controller-contract'
export { getRuntimeDesktopSurface } from './runtime-desktop-surface'
export type { IpcMainEvent } from 'electron'

// Why initiallyHidden: no renderer pane exists yet, so main must answer startup queries — Muse
// exits silently when its startup cursor-position query goes unanswered.
export const BACKGROUND_TERMINAL_SPAWN_FLAGS = {
  initiallyHidden: true,
  persistHostSessionBinding: true
} as const
