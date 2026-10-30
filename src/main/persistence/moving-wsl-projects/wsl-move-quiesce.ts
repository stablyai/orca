// Fence, Sleep, then prove exit; refusal lifts the fence but leaves already-slept workspaces restorable.
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveExitProof, WslMoveExitProofScope } from './wsl-move-exit-proof'
import type { WslMoveRestoreHintCapture, WslMoveRestoreHintPane } from './wsl-move-restore-hints'
import {
  assessWslMoveTerminals,
  type WslMoveGateBlocker,
  type WslMoveGateInputs
} from './wsl-move-terminal-gate'

export type WslMoveQuiesceScope = {
  workspaceIds: readonly string[]
  workspaceKeys: ReadonlySet<string>
  /** Capture daemon session and distro before Sleep. */
  panes: readonly WslMoveRestoreHintPane[]
}

export type WslMoveQuiesceDeps = {
  gateInputs: () => Promise<WslMoveGateInputs>
  /** Return failed workspaces; reject if the renderer cannot answer. */
  sleepWorkspaces: (workspaceIds: readonly string[]) => Promise<{ failedWorktreeIds: string[] }>
  /** Include degraded-mode PTYs absent from daemon censuses. */
  livePtyIds: (workspaceIds: readonly string[]) => readonly string[]
  captureRestoreHints: (
    panes: WslMoveQuiesceScope['panes'],
    distro: string
  ) => Promise<WslMoveRestoreHintCapture>
  proveExited: (scope: WslMoveExitProofScope) => Promise<WslMoveExitProof>
  writeCutover: (cutover: WslMoveCutover) => void
  removeCutover: (migrationId: string) => void
  now: () => Date
  /** Between Sleep attempts; tests skip the wait. */
  wait?: (ms: number) => Promise<void>
}

// A Sleep can fail once and succeed when tried again; only a repeat refuses.
const SLEEP_ATTEMPTS = 3
const SLEEP_RETRY_MS = 1_000

/** Sleeps the workspaces, again for the ones that failed; returns those that kept failing. */
export async function sleepUntilPaused(
  deps: Pick<WslMoveQuiesceDeps, 'sleepWorkspaces' | 'wait'>,
  workspaceIds: readonly string[]
): Promise<string[]> {
  let pending = workspaceIds
  for (let attempt = 1; ; attempt += 1) {
    const { failedWorktreeIds } = await deps.sleepWorkspaces(pending)
    if (failedWorktreeIds.length === 0 || attempt >= SLEEP_ATTEMPTS) {
      return failedWorktreeIds
    }
    pending = failedWorktreeIds
    await (deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
      SLEEP_RETRY_MS * attempt
    )
  }
}

export type WslMoveQuiesceRefusalReason =
  | 'terminals-blocked'
  | 'quiesce-in-progress'
  | 'fence-failed'
  | 'renderer-unavailable'
  | 'sleep-timed-out'
  | 'sleep-failed'
  | 'terminals-live'
  | 'exit-unverifiable'
  | 'journal-failed'
  | 'quiesce-failed'

export type WslMoveQuiesceResult =
  | {
      outcome: 'quiesced'
      /** Carries `terminalRestoreHints`, so a crash after quiesce keeps them. */
      cutover: WslMoveCutover
      /** The whole capture, including the panes that had no folder to keep, for the preview. */
      restoreHints: WslMoveRestoreHintCapture
    }
  | {
      outcome: 'refused'
      reason: WslMoveQuiesceRefusalReason
      blockers?: WslMoveGateBlocker[]
      failedWorktreeIds?: string[]
      liveSessionIds?: string[]
      detail?: string
      /** False if journal removal failed and the fence remains. */
      fenceLifted: boolean
    }

type Refusal = Extract<WslMoveQuiesceResult, { outcome: 'refused' }>

// The durable journal cannot serialize concurrent quiesces within this process.
const quiescingJournalKeys = new Set<string>()

export async function quiesceWslMove(
  prepared: WslMoveCutover,
  scope: WslMoveQuiesceScope,
  deps: WslMoveQuiesceDeps
): Promise<WslMoveQuiesceResult> {
  if (prepared.phase !== 'prepared') {
    throw new Error('wsl_move_not_prepared')
  }
  if (quiescingJournalKeys.has(prepared.journalKey)) {
    return { outcome: 'refused', reason: 'quiesce-in-progress', fenceLifted: true }
  }
  quiescingJournalKeys.add(prepared.journalKey)
  try {
    return await quiesceUnderLock(prepared, scope, deps)
  } finally {
    quiescingJournalKeys.delete(prepared.journalKey)
  }
}

async function quiesceUnderLock(
  prepared: WslMoveCutover,
  scope: WslMoveQuiesceScope,
  deps: WslMoveQuiesceDeps
): Promise<WslMoveQuiesceResult> {
  const gate = assessWslMoveTerminals(await deps.gateInputs())
  if (gate.verdict === 'blocked') {
    return {
      outcome: 'refused',
      reason: 'terminals-blocked',
      blockers: gate.blockers,
      fenceLifted: true
    }
  }
  const fenced: WslMoveCutover = {
    ...prepared,
    phase: 'source-fenced',
    updatedAt: deps.now().toISOString()
  }
  try {
    deps.writeCutover(fenced)
  } catch (error) {
    return {
      outcome: 'refused',
      reason: 'fence-failed',
      detail: describe(error),
      fenceLifted: true
    }
  }
  const refuse = (refusal: Omit<Refusal, 'outcome' | 'fenceLifted'>): Refusal => {
    try {
      deps.removeCutover(fenced.migrationId)
      return { outcome: 'refused', ...refusal, fenceLifted: true }
    } catch (error) {
      console.warn('[wsl-move] Could not lift the fence after a refused quiesce:', error)
      return { outcome: 'refused', ...refusal, fenceLifted: false }
    }
  }

  try {
    // The fence prevents spawns, but existing shells can still start commands.
    const fencedGate = assessWslMoveTerminals(await deps.gateInputs())
    if (fencedGate.verdict === 'blocked') {
      return refuse({ reason: 'terminals-blocked', blockers: fencedGate.blockers })
    }
  } catch (error) {
    return refuse({ reason: 'quiesce-failed', detail: describe(error) })
  }

  try {
    const failedWorktreeIds = await sleepUntilPaused(deps, scope.workspaceIds)
    if (failedWorktreeIds.length > 0) {
      return refuse({ reason: 'sleep-failed', failedWorktreeIds })
    }
  } catch (error) {
    const detail = describe(error)
    const reason =
      detail === 'renderer_unavailable'
        ? 'renderer-unavailable'
        : detail === 'worktree_sleep_timeout'
          ? 'sleep-timed-out'
          : 'sleep-failed'
    return refuse({ reason, detail })
  }

  try {
    return await proveAndRecord(fenced, scope, deps, refuse)
  } catch (error) {
    return refuse({ reason: 'quiesce-failed', detail: describe(error) })
  }
}

async function proveAndRecord(
  fenced: WslMoveCutover,
  scope: WslMoveQuiesceScope,
  deps: WslMoveQuiesceDeps,
  refuse: (refusal: Omit<Refusal, 'outcome' | 'fenceLifted'>) => Refusal
): Promise<WslMoveQuiesceResult> {
  // Sleeping removes pane processes, so use live-session evidence rather than the pane gate.
  const live = deps.livePtyIds(scope.workspaceIds)
  if (live.length > 0) {
    return refuse({ reason: 'terminals-live', liveSessionIds: [...live] })
  }
  const distro = fenced.manifest.source.distro
  const restoreHints = await deps.captureRestoreHints(scope.panes, distro)
  const sessionIds = new Set(scope.panes.map((pane) => pane.sessionId))
  // Check exit last to catch sessions revived during hint capture.
  const proof = await deps.proveExited({ distro, workspaceKeys: scope.workspaceKeys, sessionIds })
  if (proof.verdict === 'live') {
    return refuse({ reason: 'terminals-live', liveSessionIds: proof.sessionIds })
  }
  if (proof.verdict === 'unverifiable') {
    return refuse({ reason: 'exit-unverifiable', detail: proof.reason })
  }
  const quiesced: WslMoveCutover = {
    ...fenced,
    phase: 'quiesced',
    updatedAt: deps.now().toISOString(),
    provenExitedSessionIds: [...sessionIds],
    terminalRestoreHints: restoreHints.hints.map((hint) => ({ ...hint }))
  }
  try {
    deps.writeCutover(quiesced)
  } catch (error) {
    return refuse({ reason: 'journal-failed', detail: describe(error) })
  }
  return { outcome: 'quiesced', cutover: quiesced, restoreHints }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
