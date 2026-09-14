import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import type { PtySpawnResult } from '../../../providers/types'
import type { CodexPaneHomeRoute } from '../../../codex/codex-pane-account-registry'
import { createPtySpawnTiming } from '../../pty-spawn-timing'
import { allocatePtyLifecycleSequence } from '../host-env/types'
import { snapshotCodexPaneHomeRoutes } from '../host-env/codex-home'
import { getAppPtyId } from '../provider/registry'
import {
  makePaneSpawnReservationKey,
  reservePaneSpawn,
  paneSpawnReservationsByOwnerKey,
  pendingRuntimePaneCreatesByOwnerKey
} from '../pane/spawn-reservation'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import type { PtyIpcSpawnState } from './spawn-state'

export async function beginPtyIpcSpawn(
  ctx: PtyIpcSpawnState
): Promise<PtySpawnResult | { isReattach: true } | null> {
  const args = ctx.args
  ctx.codexHomeLaunchStartedAt = !args.connectionId ? new Date() : undefined
  ctx.codexHomeLaunchStartedSequence = !args.connectionId
    ? allocatePtyLifecycleSequence()
    : undefined
  const initialLeafId =
    typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
  const initialPaneKey =
    typeof args.worktreeId === 'string' &&
    typeof args.tabId === 'string' &&
    isValidTerminalTabId(args.tabId) &&
    args.tabId.length <= 512 &&
    initialLeafId
      ? makePaneKey(args.tabId, initialLeafId)
      : null
  const initialStablePanePtyId = (() => {
    try {
      return !args.connectionId && initialPaneKey
        ? resolveStablePaneOwner(
            ctx.deps.runtime,
            ctx.deps.store,
            initialPaneKey,
            args.worktreeId,
            args.connectionId
          )?.ptyId
        : undefined
    } catch {
      return undefined
    }
  })()
  ctx.reattachedCodexHomeRoutes = !args.connectionId
    ? new Map(
        snapshotCodexPaneHomeRoutes([
          initialStablePanePtyId,
          args.sessionId ? getAppPtyId(args.connectionId, args.sessionId) : undefined
        ])
      )
    : new Map<string, CodexPaneHomeRoute | null>()
  ctx.spawnTiming = createPtySpawnTiming()
  ctx.cwd = ctx.deps.resolvePtySpawnStartupCwd(args.worktreeId, args.cwd)

  const earlyLeafId =
    typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
  const earlyPaneKey =
    typeof args.worktreeId === 'string' &&
    typeof args.tabId === 'string' &&
    isValidTerminalTabId(args.tabId) &&
    args.tabId.length <= 512 &&
    earlyLeafId
      ? makePaneKey(args.tabId, earlyLeafId)
      : null
  const earlyReservationKey = makePaneSpawnReservationKey(
    args.worktreeId,
    args.connectionId,
    earlyPaneKey
  )
  const pendingRuntimeCreate = earlyReservationKey
    ? pendingRuntimePaneCreatesByOwnerKey.get(earlyReservationKey)
    : undefined
  if (pendingRuntimeCreate) {
    await pendingRuntimeCreate.promise
  }
  const existingPaneSpawn = earlyReservationKey
    ? paneSpawnReservationsByOwnerKey.get(earlyReservationKey)
    : undefined
  if (existingPaneSpawn) {
    return { ...(await existingPaneSpawn.promise), isReattach: true }
  }
  ctx.earlyStablePaneOwner =
    earlyPaneKey && args.worktreeId
      ? resolveStablePaneOwner(
          ctx.deps.runtime,
          ctx.deps.store,
          earlyPaneKey,
          args.worktreeId,
          args.connectionId
        )
      : null
  ctx.earlyWorktreeId = args.worktreeId
  // Reserve early so renderer/runtime materialization cannot start duplicate provider spawns.
  ctx.paneSpawnReservationKey = earlyReservationKey
  ctx.paneSpawnReservation = ctx.paneSpawnReservationKey
    ? reservePaneSpawn(ctx.paneSpawnReservationKey)
    : null
  ctx.finishTerminalInstall = (): void => {}
  ctx.stablePaneOwner = null
  ctx.stablePaneBindingPersisted = false
  ctx.rejectedRegistrationCandidate = null
  ctx.pendingRegistrationPtyId = null
  // Why hoisted to the reply scope: main reconciles the provider sequence
  // deep inside the spawn path, but the pane needs that renderer-domain
  // boundary beside the daemon snapshot's kitty flags.
  ctx.reconciledSnapshotSeq = null
  // False when bytes crossed the data socket during the spawn RPC: the
  // reconciled boundary covers them, but the daemon proved its kitty flags
  // before they existed, so the claim must not erase what the pane may
  // have scanned from those bytes live.
  ctx.snapshotKittyFlagsCoverReconciledSeq = true
  ctx.preparedProvisionalExecutionContext = false

  return null
}
