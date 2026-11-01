import { formatTerminalStartFailure } from '../../../../shared/terminal-start-failure'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { AgentLaunchTarget } from '../../../../shared/agent-launch-intent'
import {
  WorktreeCreateCollisionError,
  WORKTREE_CREATE_COLLISION_CODE
} from '../../../../shared/new-workspace/worktree-create-collision'
import {
  AgentLaunchPaneAlreadyLiveError,
  AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE
} from '../../../../shared/agent-launch-pane-already-live'
import {
  AgentLaunchSessionAlreadyExistsError,
  AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE
} from '../../../../shared/agent-launch-session-already-exists'
import type { TerminalSpawnDispatch } from '../../../agent-launch/agent-launch-not-started'
import { FolderWorkspaceCreateRefusedError } from '../../../project-groups/folder-workspace-create-refusal'
import { WorktreeCreateSetupChoiceRefusedError } from '../../worktree-create-setup-choice-refusal'
import { AgentLaunchSurfaceUnavailableError } from '../../../agent-launch/agent-launch-surface-refusal'

/** Long enough for every code this path raises, with room for one a later guard adds. */
const LAUNCH_FAILURE_CODE_MAX_LENGTH = 128
/** Refusal text that may name a path as long as Linux's PATH_MAX, after its code. */
const REFUSAL_TEXT_MAX_LENGTH = 4096 + LAUNCH_FAILURE_CODE_MAX_LENGTH

/** Bound error text on ingestion because the ledger is serialized whole per operation.
 * Do not impose the bound in row validation: rejecting a row this build wrote loses the entire store. */
export function agentLaunchFailureCode(error: unknown): string {
  const code =
    error instanceof OrchestrationError ? error.code : error instanceof Error ? error.message : ''
  return code.length > 0 ? code.slice(0, LAUNCH_FAILURE_CODE_MAX_LENGTH) : 'agent_launch_failed'
}

/** A coded refusal's own words, kept beside its code so a replay says the same; bounded likewise. */
export function agentLaunchFailureMessage(error: unknown): string | undefined {
  return (
    formatTerminalStartFailure(error) ??
    (error instanceof OrchestrationError
      ? error.message.slice(0, REFUSAL_TEXT_MAX_LENGTH)
      : undefined)
  )
}

/** Keep a refused folder's full path or only its code; truncating the path would name a different folder. */
function folderCreateRefusalCode(error: FolderWorkspaceCreateRefusedError): string {
  const { message } = error
  const pathStart = message.indexOf(':')
  return message.length <= REFUSAL_TEXT_MAX_LENGTH || pathStart === -1
    ? message
    : message.slice(0, pathStart)
}

/** Only typed pre-effect refusals prove no effects.
 * Create refusal proves this for any target; reserved-pane/session conflicts prove it only for existing workspaces, since create targets already made theirs. */
export function launchFailureWithoutEffectsCode(
  error: unknown,
  targetKind: AgentLaunchTarget['kind'],
  terminalSpawn: TerminalSpawnDispatch
): string | null {
  if (error instanceof WorktreeCreateCollisionError) {
    return WORKTREE_CREATE_COLLISION_CODE
  }
  if (error instanceof FolderWorkspaceCreateRefusedError) {
    return folderCreateRefusalCode(error)
  }
  // Raised only before launch effects, including definitive existing-workspace refusals.
  if (error instanceof AgentLaunchSurfaceUnavailableError) {
    return agentLaunchFailureCode(error)
  }
  if (error instanceof WorktreeCreateSetupChoiceRefusedError && targetKind === 'create-worktree') {
    return agentLaunchFailureCode(error)
  }
  if (error instanceof AgentLaunchPaneAlreadyLiveError && targetKind === 'existing') {
    return AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE
  }
  if (error instanceof AgentLaunchSessionAlreadyExistsError && targetKind === 'existing') {
    return AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE
  }
  if (terminalSpawn.failedBeforeDispatch(error) && targetKind === 'existing') {
    return agentLaunchFailureCode(error)
  }
  return null
}
