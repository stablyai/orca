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

/** Long enough for every code this path raises, with room for one a later guard adds. */
const LAUNCH_FAILURE_CODE_MAX_LENGTH = 128
/** A path as long as Linux's PATH_MAX, after its code. */
const FOLDER_CREATE_REFUSAL_MAX_LENGTH = 4096 + LAUNCH_FAILURE_CODE_MAX_LENGTH

/**
 * This path raises its refusals as the thrown code, the way the method's own guards do — and the
 * recorded code is what a replay answers with, so it is worth keeping.
 *
 * Bounded because a code is an identifier but `error.message` is free text: an errno sentence
 * carrying an absolute path arrives here as one, and it would be written into a ledger file that is
 * re-serialized whole on every subsequent operation. Bounded on the way IN only. A length check in
 * `isAgentSessionOperationRow` would reject rows this same build wrote, and one rejected row costs
 * the entire store.
 */
export function agentLaunchFailureCode(error: unknown): string {
  const code =
    error instanceof OrchestrationError ? error.code : error instanceof Error ? error.message : ''
  return code.length > 0 ? code.slice(0, LAUNCH_FAILURE_CODE_MAX_LENGTH) : 'agent_launch_failed'
}

/**
 * A refused folder create names its folder, and the user is shown that path, so a replay carries all
 * of it or none: a path cut short names a different folder. Any path a filesystem stat accepts
 * fits; past that, only the code before the path is kept.
 */
function folderCreateRefusalCode(error: FolderWorkspaceCreateRefusedError): string {
  const { message } = error
  const pathStart = message.indexOf(':')
  return message.length <= FOLDER_CREATE_REFUSAL_MAX_LENGTH || pathStart === -1
    ? message
    : message.slice(0, pathStart)
}

/**
 * Only a typed refusal raised before anything was created proves the claimed launch had no effects.
 * A refused create proves it for any target, since the create is the launch's first effect. A live
 * reserved pane or an existing reserved session proves it only for an existing workspace; on a
 * create target the workspace already exists by the time the surface is refused.
 */
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
