import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeSession } from '../claude-structured-session-state'

type PickSession = Pick<ClaudeSession, 'launchIntent' | 'permissionPick' | 'liveFullAccess'>

/**
 * The one owner of a chat's live permission picks. Each pick gets the next number and becomes the
 * mode every later write sends; auto-approval follows it at once (Claude's wire-order reports still
 * decide where Full access applies). A write made for a pick records Claude's answer only while
 * that pick is still the latest: a newer pick's write goes out behind it and records its own.
 */
export function pickClaudePermissionMode(session: PickSession, mode: PermissionMode): number {
  session.launchIntent = { ...session.launchIntent, permissionMode: mode }
  session.permissionPick = (session.permissionPick ?? 0) + 1
  session.liveFullAccess?.picked(mode === 'bypassPermissions')
  return session.permissionPick
}

/** True while no pick has been made since this was called. */
export function claudePermissionPickHolds(
  session: Pick<ClaudeSession, 'permissionPick'>
): () => boolean {
  const pick = session.permissionPick
  return () => session.permissionPick === pick
}

/** Records a write's answer for the pick it was made for; a newer pick's write records its own. */
export function recordClaudeBuildMode(
  session: Pick<ClaudeSession, 'appliedInputOptions'>,
  holds: () => boolean,
  mode: PermissionMode | null
): void {
  if (!holds()) {
    return
  }
  if (mode === null) {
    session.appliedInputOptions.delete('buildPermissionMode')
  } else {
    session.appliedInputOptions.set('buildPermissionMode', mode)
  }
}

/** A pick saved while a kept agent reattaches goes to Claude at ready (a numbered pick then);
 *  auto-approval follows it now, ahead of the requests the reattach releases. */
export function claudePermissionPickedWhileStarting(
  session: Pick<ClaudeSession, 'liveFullAccess'>,
  fullAccess: boolean
): void {
  session.liveFullAccess?.picked(fullAccess)
}
