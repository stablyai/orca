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

/** Long enough for every code this path raises, with room for one a later guard adds. */
const LAUNCH_FAILURE_CODE_MAX_LENGTH = 128

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
  const code = error instanceof Error ? error.message : ''
  return code.length > 0 ? code.slice(0, LAUNCH_FAILURE_CODE_MAX_LENGTH) : 'agent_launch_failed'
}

/**
 * Only a typed refusal raised before anything was created proves the claimed launch had no effects.
 * A live reserved pane or an existing reserved session proves it only for an existing workspace; on
 * create-worktree the workspace already exists by the time the surface is refused.
 */
export function launchFailureWithoutEffectsCode(
  error: unknown,
  targetKind: AgentLaunchTarget['kind'],
  terminalSpawn: TerminalSpawnDispatch
): string | null {
  if (error instanceof WorktreeCreateCollisionError) {
    return WORKTREE_CREATE_COLLISION_CODE
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
