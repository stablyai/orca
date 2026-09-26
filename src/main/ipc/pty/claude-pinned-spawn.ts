import { isClaudeLaunchCommand } from './host-env/fresh-spawn-routing'
import { claudePinnedLaunchError } from '../../../shared/claude/claude-pinned-launch-error'
import { markClaudePtySpawned } from '../../claude-accounts/live-pty-gate'
import {
  markPinnedClaudePtySpawned,
  releaseClaudePinnedAccountReservation
} from '../../claude-accounts/claude-pinned-pty-registry'
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
  // Why: the active path (`managed:<id>`) also honours the request; any other account must not run.
  if (
    claudeAuth.provenance !== `managed:${pinnedAccountId}:pinned` &&
    claudeAuth.provenance !== `managed:${pinnedAccountId}`
  ) {
    // Why: the caller never sees this preparation, so its spawn finally cannot release the hold.
    releasePinnedClaudeReservation(claudeAuth)
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
    // Why: a pinned PTY guards its own account, not the active one the global gate defers.
    markPinnedClaudePtySpawned(ptyId, claudeAuth.pinnedAccountId)
    return
  }
  markClaudePtySpawned(ptyId, claudeAuth?.provenance)
}

export function releasePinnedClaudeReservation(
  claudeAuth: ClaudeRuntimeAuthPreparation | null
): void {
  if (claudeAuth?.pinnedAccountId) {
    releaseClaudePinnedAccountReservation(claudeAuth.pinnedAccountId)
  }
}
