import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { attachOnlyViewOf } from '../pane/attach-only-view'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { resolveAgentLaunchPaneVerdict } from '../../../agent-launch/agent-launch-pane-attachment'
import { AGENT_LAUNCH_PANE_REFUSED_CODE } from '../../../../shared/agent-launch-pane-verdict'
import { agentLaunchPaneLiveness } from '../pane/agent-launch-pane-evidence'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { CodexPaneHomeRoute } from '../../../codex/codex-pane-account-registry'
import { createPtySpawnTiming } from '../pty-spawn-timing'
import { allocatePtyLifecycleSequence } from '../host-env/types'
import { snapshotCodexPaneHomeRoutes } from '../host-env/codex-home'
import { getAppPtyId } from '../provider/registry'
import {
  makePaneSpawnReservationKey,
  pendingRuntimePaneCreatesByOwnerKey
} from '../pane/spawn-reservation'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import { excludeReplacedPaneOwner } from '../pane/replaced-pane-owner'
import type { PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs } from './spawn-types'

export function resolveEarlyPaneKey(args: PtySpawnIpcArgs): string | null {
  const leafId =
    typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
  return typeof args.worktreeId === 'string' &&
    typeof args.tabId === 'string' &&
    isValidTerminalTabId(args.tabId) &&
    args.tabId.length <= 512 &&
    leafId
    ? makePaneKey(args.tabId, leafId)
    : null
}

export function resolveEarlyPaneSpawnReservationKey(args: PtySpawnIpcArgs): string | null {
  return makePaneSpawnReservationKey(args.worktreeId, args.connectionId, resolveEarlyPaneKey(args))
}

export async function beginPtyIpcSpawn(
  ctx: PtyIpcSpawnState
): Promise<PtySpawnResult | { isReattach: true } | null> {
  const args = ctx.args
  // Launch panes adopt their agent instead of starting a shell; explicit restarts already own the reservation.
  const launchPaneKey = ctx.paneSpawnReservation ? null : resolveEarlyPaneKey(args)
  const launchVerdict =
    launchPaneKey && args.worktreeId && args.tabId && args.leafId
      ? resolveAgentLaunchPaneVerdict(
          { worktreeId: args.worktreeId, paneKey: launchPaneKey },
          agentLaunchPaneLiveness(ctx.deps, {
            worktreeId: args.worktreeId,
            tabId: args.tabId,
            leafId: args.leafId,
            connectionId: args.connectionId
          })
        )
      : null
  if (launchVerdict && args.worktreeId && args.tabId && args.leafId) {
    const verdict = await launchVerdict
    ctx.deps.runtime?.reportAgentLaunchPaneVerdict?.(
      { worktreeId: args.worktreeId, tabId: args.tabId, leafId: args.leafId },
      verdict
    )
    if (verdict.kind !== 'proceed') {
      throw new Error(AGENT_LAUNCH_PANE_REFUSED_CODE)
    }
  }
  ctx.codexHomeLaunchStartedAt = !args.connectionId ? new Date() : undefined
  ctx.codexHomeLaunchStartedSequence = !args.connectionId
    ? allocatePtyLifecycleSequence()
    : undefined
  const initialPaneKey = resolveEarlyPaneKey(args)
  const initialStablePanePtyId = (() => {
    try {
      return !args.connectionId && initialPaneKey
        ? excludeReplacedPaneOwner(
            resolveStablePaneOwner(
              ctx.deps.runtime,
              ctx.deps.store,
              initialPaneKey,
              args.worktreeId,
              args.connectionId
            ),
            ctx.replacedPaneOwner
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

  const earlyReservationKey = resolveEarlyPaneSpawnReservationKey(args)
  // Replacement holds the reservation before stopping; joining itself would deadlock.
  const heldReservation = ctx.paneSpawnReservation
  if (!heldReservation) {
    const pendingRuntimeCreate = earlyReservationKey
      ? pendingRuntimePaneCreatesByOwnerKey.get(earlyReservationKey)
      : undefined
    if (pendingRuntimeCreate) {
      const created = await pendingRuntimeCreate.promise
      // Reuse main's current start payload when available to avoid a second provider attach round trip.
      if (
        attachOnlyViewOf(args) &&
        created &&
        created.id === args.sessionId &&
        (created.coldRestore || typeof created.snapshot === 'string') &&
        ptyOwnership.has(created.id) &&
        (created.incarnationId === undefined ||
          ptyIncarnationById.get(created.id) === created.incarnationId)
      ) {
        return created
      }
    }
  }
  ctx.earlyStablePaneOwner =
    initialPaneKey && args.worktreeId
      ? excludeReplacedPaneOwner(
          resolveStablePaneOwner(
            ctx.deps.runtime,
            ctx.deps.store,
            initialPaneKey,
            args.worktreeId,
            args.connectionId
          ),
          ctx.replacedPaneOwner
        )
      : null
  ctx.earlyWorktreeId = args.worktreeId
  ctx.paneSpawnReservationKey = earlyReservationKey
  ctx.paneSpawnReservation = heldReservation ?? null
  ctx.finishTerminalInstall = (): void => {}
  ctx.stablePaneOwner = null
  ctx.stablePaneBindingPersisted = false
  ctx.rejectedRegistrationCandidate = null
  ctx.pendingRegistrationPtyId = null
  // Carry renderer-domain sequence reconciliation into the spawn reply beside proven kitty flags.
  ctx.reconciledSnapshotSeq = null
  // Bytes arriving during spawn can postdate proven flags; do not let old flags erase their live negotiation.
  ctx.snapshotKittyFlagsCoverReconciledSeq = true
  ctx.preparedProvisionalExecutionContext = false

  return null
}
