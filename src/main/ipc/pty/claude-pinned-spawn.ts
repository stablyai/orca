import { isClaudeLaunchCommand } from './host-env/fresh-spawn-routing'
import { claudePinnedLaunchError } from '../../../shared/claude/claude-pinned-launch-error'
import { markPinnedClaudePtySpawned } from '../../claude-accounts/claude-pinned-pty-registry'
import type { PrepareClaudeAuth } from './host-env/types'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from '../../claude-accounts/runtime-selection'

type ClaudeLaunchShape = {
  preAdoptedStablePane: boolean
  connectionId?: string | null
  command?: string
  launchAgent?: string
}

export function isFreshClaudeLaunch(
  launch: ClaudeLaunchShape,
  pinnedAccountId: string | undefined,
  options?: { trustLaunchAgent?: boolean }
): boolean {
  if (launch.preAdoptedStablePane || launch.connectionId) {
    return false
  }
  // Why: a wait-for-setup launch types a setup gate, not `claude`; for a pinned launch the agent id is the proof.
  return (
    isClaudeLaunchCommand(launch.command) ||
    ((Boolean(pinnedAccountId) || Boolean(options?.trustLaunchAgent)) &&
      launch.launchAgent === 'claude')
  )
}

export async function preparePinnableClaudeAuth(
  prepare: PrepareClaudeAuth | undefined,
  target: ClaudeAccountSelectionTarget,
  pinnedAccountId: string | undefined
): Promise<ClaudeRuntimeAuthPreparation | null> {
  if (!prepare) {
    if (pinnedAccountId) {
      throw new Error('This Orca runtime cannot prepare Claude accounts for pinned launches.')
    }
    return null
  }
  if (!pinnedAccountId) {
    return prepare(target)
  }
  const claudeAuth = await prepare(target, { accountId: pinnedAccountId })
  // Why: the selected account's path (`profile:<id>`) also honours the request; no other may run.
  if (
    claudeAuth.provenance !== `profile:${pinnedAccountId}:pinned` &&
    claudeAuth.provenance !== `profile:${pinnedAccountId}`
  ) {
    throw claudePinnedLaunchError(
      'provenance',
      'Orca could not prepare the requested Claude account for this launch. Check `orca account list` and retry.'
    )
  }
  return claudeAuth
}

export function markClaudePtySpawnedForAuth(
  ptyId: string,
  claudeAuth: ClaudeRuntimeAuthPreparation | null
): void {
  if (claudeAuth?.pinnedAccountId) {
    markPinnedClaudePtySpawned(ptyId, claudeAuth.pinnedAccountId)
  }
}
