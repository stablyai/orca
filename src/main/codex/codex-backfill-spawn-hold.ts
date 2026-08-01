import type { CodexBackfillPaneHoldState } from '../../shared/codex-backfill-status-types'
import { isCodexBackfillIndexPending, readCodexStateDbBackfillStatus } from './codex-state-db'

// Why: 5s keeps held panes snappy after completion without hammering sqlite (the retired renderer gate polled at 20s).
export const CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS = 5_000
// Why: mirror the retired renderer gate's ceiling — fail open rather than brick a pane (#11828).
export const CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS = 15 * 60_000

export type CodexBackfillSpawnHoldDecisionInput = {
  launchAgent: string | undefined
  startupCommand: string | undefined
  connectionId: string | null | undefined
  codexHomePath: string | null
  isPending?: (codexHomePath: string) => boolean
}

/** Why: gate only what we can locally verify — everything else launches normally (fail-open, #11828). */
export function shouldHoldCodexSpawnForBackfill(
  input: CodexBackfillSpawnHoldDecisionInput
): boolean {
  if (input.launchAgent !== 'codex') {
    return false
  }
  if (input.connectionId) {
    return false
  }
  if (!input.startupCommand || !input.codexHomePath) {
    return false
  }
  const isPending = input.isPending ?? isCodexBackfillIndexPending
  try {
    return isPending(input.codexHomePath)
  } catch {
    return false
  }
}

export type CodexBackfillHoldPollResult = {
  pending: boolean
  unreadable: boolean
  lastWatermark: string | null
}

/** Why: once holding, a transient sqlite failure under the prewarm's active writes must not release the gate early. */
export function evaluateCodexBackfillHoldPoll(codexHomePath: string): CodexBackfillHoldPollResult {
  try {
    const status = readCodexStateDbBackfillStatus(codexHomePath)
    if (status.kind === 'unreadable') {
      return { pending: true, unreadable: true, lastWatermark: null }
    }
    const lastWatermark = status.kind === 'incomplete' ? status.lastWatermark : null
    return { pending: isCodexBackfillIndexPending(codexHomePath), unreadable: false, lastWatermark }
  } catch {
    return { pending: true, unreadable: true, lastWatermark: null }
  }
}

export type CodexBackfillPaneHoldBeginParams = {
  paneKey: string
  codexHomePath: string
  releaseHeldCommand: () => void
  evaluate?: (codexHomePath: string) => CodexBackfillHoldPollResult
  repollMs?: number
  maxWaitMs?: number
}

export type CodexBackfillPaneHoldHandle = {
  dispose: () => void
}

export type CodexBackfillPaneHoldRegistry = {
  begin: (params: CodexBackfillPaneHoldBeginParams) => CodexBackfillPaneHoldHandle
  get: (paneKey: string) => CodexBackfillPaneHoldState | null
  disposeAll: () => void
}

type HeldPane = {
  state: CodexBackfillPaneHoldState
  timer: ReturnType<typeof setInterval>
}

export function createCodexBackfillPaneHoldRegistry(deps: {
  broadcast: (state: CodexBackfillPaneHoldState) => void
}): CodexBackfillPaneHoldRegistry {
  const holds = new Map<string, HeldPane>()

  const drop = (paneKey: string): void => {
    const held = holds.get(paneKey)
    if (held) {
      clearInterval(held.timer)
      holds.delete(paneKey)
    }
  }

  const begin = (params: CodexBackfillPaneHoldBeginParams): CodexBackfillPaneHoldHandle => {
    drop(params.paneKey)
    const evaluate = params.evaluate ?? evaluateCodexBackfillHoldPoll
    const repollMs = params.repollMs ?? CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS
    const maxWaitMs = params.maxWaitMs ?? CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS
    const deadline = Date.now() + maxWaitMs

    const initial = evaluate(params.codexHomePath)
    const held: HeldPane = {
      state: { paneKey: params.paneKey, phase: 'indexing', lastWatermark: initial.lastWatermark },
      timer: setInterval(() => {
        const result = evaluate(params.codexHomePath)
        // Why: 15-minute ceiling fails open — a stuck index must not brick the pane (#11828).
        if (!result.pending || Date.now() >= deadline) {
          drop(params.paneKey)
          deps.broadcast({ paneKey: params.paneKey, phase: 'launched', lastWatermark: null })
          params.releaseHeldCommand()
          return
        }
        if (!result.unreadable && result.lastWatermark !== held.state.lastWatermark) {
          held.state = { ...held.state, lastWatermark: result.lastWatermark }
          deps.broadcast(held.state)
        }
      }, repollMs)
    }
    held.timer.unref?.()
    holds.set(params.paneKey, held)
    deps.broadcast(held.state)

    return { dispose: () => drop(params.paneKey) }
  }

  return {
    begin,
    get: (paneKey) => holds.get(paneKey)?.state ?? null,
    disposeAll: () => {
      // Why: Map tolerates deletion during iteration, so no key snapshot is needed.
      for (const paneKey of holds.keys()) {
        drop(paneKey)
      }
    }
  }
}
