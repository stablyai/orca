/**
 * Bringing moved projects back to this computer: one project's move ("Use on this computer
 * again"), or a distro's whole chain (R38 Restore). Host copies stop first, then the moves are
 * dropped newest first, then the window reloads once to hydrate the pre-move session.
 */
import {
  WSL_MOVE_CUTOVER_PHASES,
  wslMoveJournalKey,
  type WslMoveCutover
} from '../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveUseLocallyResult } from '../../shared/wsl-move/wsl-moved-project'
import { listWslMoveCutoverChain } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import type { WslMoveProjectRef } from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { fenceHostSpawnsForWslMoveUndo } from '../persistence/moving-wsl-projects/wsl-move-undo-spawn-fence'
import {
  findWslMovedProjectMove,
  releaseWslMove,
  wslMoveReleaseRefusal,
  wslMoveWorkspacesInScope
} from '../persistence/moving-wsl-projects/wsl-move-use-locally'
import {
  holdWslMoveWindowWrites,
  reloadWslMoveWindowWithWritesHeld
} from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import type { WslMoveUndoPorts } from './wsl-move-undo-wiring'
import {
  wslMoveHostCopiesSlept,
  wslMoveHostCopyOutcome
} from '../persistence/moving-wsl-projects/wsl-move-host-copy-stop'
import { beginWslMoveUndoRun } from '../persistence/moving-wsl-projects/wsl-move-running-moves'
import { runWslMoveHostAutomationsExclusive } from '../persistence/moving-wsl-projects/wsl-move-undo-host-automations'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { wasWslHostKeptForPeers } from '../wsl/wsl-host-kept-for-peers'

const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

const releasedByUserListeners = new Set<(distro: string) => void>()

/** Hears each "Use on this computer again" that released a move; Restore is not one. */
export function onWslMoveReleasedByUser(listener: (distro: string) => void): () => void {
  releasedByUserListeners.add(listener)
  return () => releasedByUserListeners.delete(listener)
}

/** "Use on this computer again" for one project: its whole move comes back and the window reloads. */
export async function releaseWslMovedProjectHere(
  userDataPath: string,
  ref: WslMoveProjectRef,
  unsavedWorkspaceIdsAsked: readonly string[],
  createUndoPorts: () => WslMoveUndoPorts
): Promise<WslMoveUseLocallyResult> {
  const found = findWslMovedProjectMove(userDataPath, ref)
  if (!('move' in found)) {
    return found
  }
  const result = await releaseWslMovesHere(
    userDataPath,
    [found.move],
    unsavedWorkspaceIdsAsked,
    createUndoPorts
  )
  if (result.released) {
    for (const listener of releasedByUserListeners) {
      listener(result.distro)
    }
  }
  return result
}

/** R38 Restore: every finished move of the distro comes back in one go, newest first. */
export async function releaseWslMoveChainHere(
  userDataPath: string,
  distro: string,
  unsavedWorkspaceIdsAsked: readonly string[],
  createUndoPorts: () => WslMoveUndoPorts
): Promise<WslMoveUseLocallyResult> {
  const moves = listWslMoveCutoverChain(userDataPath, wslMoveJournalKey(distro))
    .filter((move) => WSL_MOVE_CUTOVER_PHASES.indexOf(move.phase) >= COMMITTED_FROM)
    .toReversed()
  return moves.length > 0
    ? releaseWslMovesHere(userDataPath, moves, unsavedWorkspaceIdsAsked, createUndoPorts)
    : { released: false, reason: 'not-moved' }
}

async function releaseWslMovesHere(
  userDataPath: string,
  newestFirst: readonly WslMoveCutover[],
  unsavedWorkspaceIdsAsked: readonly string[],
  createUndoPorts: () => WslMoveUndoPorts
): Promise<WslMoveUseLocallyResult> {
  // Taken before any guard or host connect: that connect wakes the move orchestrator, whose run of
  // this distro must not claim one mid-undo. An update install also waits until this returns.
  const endUndoRun = beginWslMoveUndoRun(newestFirst[0].manifest.source.distro)
  try {
    return await releaseWslMovesHereNow(
      userDataPath,
      newestFirst,
      unsavedWorkspaceIdsAsked,
      createUndoPorts
    )
  } finally {
    endUndoRun()
  }
}

async function releaseWslMovesHereNow(
  userDataPath: string,
  newestFirst: readonly WslMoveCutover[],
  unsavedWorkspaceIdsAsked: readonly string[],
  createUndoPorts: () => WslMoveUndoPorts
): Promise<WslMoveUseLocallyResult> {
  // Only the moves' own workspaces reload from their pre-move state; other unsaved files stay.
  const unsavedWorkspaceIds = [
    ...new Set(
      newestFirst.flatMap((move) => wslMoveWorkspacesInScope(move, unsavedWorkspaceIdsAsked))
    )
  ]
  if (unsavedWorkspaceIds.length > 0) {
    return { released: false, reason: 'unsaved-files', unsavedWorkspaceIds }
  }
  const first = newestFirst[0]
  // Why before the stop: a refused undo must leave the host's copies running (X1).
  const refusal = wslMoveReleaseRefusal(userDataPath, first)
  if (refusal) {
    return refusal
  }
  // Fenced until the reload: an open host pane would otherwise start its stopped agent again.
  const releaseSpawnFence = fenceHostSpawnsForWslMoveUndo(first.destinationEnvironmentId)
  let fenceHandedToReload = false
  try {
    const repoIds: string[] = []
    const folderWorkspaceIds: string[] = []
    const released: WslMoveCutover[] = []
    let failure: Extract<WslMoveUseLocallyResult, { released: false }> | null = null
    for (const move of newestFirst) {
      const moveRefusal = move === first ? null : wslMoveReleaseRefusal(userDataPath, move)
      if (moveRefusal) {
        failure = moveRefusal
        break
      }
      // A left-off retry must not turn a host copy back on between this move's steps.
      const step = await runWslMoveHostAutomationsExclusive(() =>
        releaseOneMoveHere(userDataPath, move, createUndoPorts())
      )
      if (!step.released) {
        failure = step
        break
      }
      released.push(move)
      repoIds.push(...step.repoIds)
      folderWorkspaceIds.push(...step.folderWorkspaceIds)
    }
    if (repoIds.length === 0 && folderWorkspaceIds.length === 0) {
      return failure ?? { released: false, reason: 'not-moved' }
    }
    // Released moves stay released even if an older one refused; the reload shows what came back.
    holdWslMoveWindowWrites()
    // Focus left on a host copy would reopen its panes after the reload and restart their agents.
    const ports = createUndoPorts()
    for (const move of released) {
      ports.refocusHere?.(move)
    }
    fenceHandedToReload = true
    reloadWslMoveWindowWithWritesHeld(releaseSpawnFence)
    return (
      failure ?? {
        released: true,
        distro: first.manifest.source.distro,
        repoIds,
        folderWorkspaceIds
      }
    )
  } finally {
    // Any refusal, or a throw, before the reload took the fence over releases it here.
    if (!fenceHandedToReload) {
      releaseSpawnFence()
    }
  }
}

/** R39: removed here but kept running for another Orca; only re-adding the host reaches it again. */
function wslMoveHostKeptForPeers(userDataPath: string, move: WslMoveCutover): boolean {
  return (
    wasWslHostKeptForPeers(userDataPath, move.destinationEnvironmentId) &&
    !listEnvironments(userDataPath).some((env) => env.id === move.destinationEnvironmentId)
  )
}

function keptForPeersRefusal(): WslMoveUseLocallyResult {
  return { released: false, reason: 'host-unreachable', detail: 'host-kept-for-peers' }
}

/** One move: host automations off, host terminals stopped, then released; refused, all undone. */
async function releaseOneMoveHere(
  userDataPath: string,
  move: WslMoveCutover,
  ports: WslMoveUndoPorts
): Promise<WslMoveUseLocallyResult> {
  // Automations first, as they undo cleanly: a refusal must leave the host's terminals running (X1).
  const automations = (await ports.stopHostAutomations?.(move)) ?? {
    outcome: 'stopped',
    restore: async () => {},
    applyHere: () => () => {}
  }
  if (automations.outcome !== 'stopped') {
    if (automations.outcome === 'unreachable' && wslMoveHostKeptForPeers(userDataPath, move)) {
      return keptForPeersRefusal()
    }
    return {
      released: false,
      reason: automations.outcome === 'unreachable' ? 'host-unreachable' : 'failed',
      detail:
        automations.outcome === 'removal-pending' ? 'host-removal-pending' : 'host-automations'
    }
  }
  // Re-checked last before the stop: a refusal after it would leave the host's terminals stopped.
  const late = wslMoveReleaseRefusal(userDataPath, move)
  if (late) {
    await automations.restore()
    return late
  }
  // The host's copies stop next, or an agent the move resumed there runs beside this one.
  const stopped = await ports.stopHostCopies(move).catch(() => 'unreachable' as const)
  const stop = wslMoveHostCopyOutcome(stopped)
  // Any refusal from here on leaves the host's terminals in ordinary Sleep: opening resumes them.
  const asleep = wslMoveHostCopiesSlept(stopped) ? { hostTerminalsAsleep: true as const } : {}
  if (stop !== 'stopped') {
    await automations.restore()
    if (stop === 'unreachable' && wslMoveHostKeptForPeers(userDataPath, move)) {
      return keptForPeersRefusal()
    }
    return {
      released: false,
      reason: stop === 'unreachable' ? 'host-unreachable' : 'host-still-running',
      ...asleep
    }
  }
  // Written here just before the release (the record keeps the choice), and undone if it refuses.
  const revertHere = automations.applyHere()
  const release = releaseWslMove(userDataPath, move)
  if (!release.released) {
    try {
      revertHere()
    } finally {
      // The host's copies go back on even if putting the copies here back failed.
      await automations.restore()
    }
    return { ...release, ...asleep }
  }
  return release
}
