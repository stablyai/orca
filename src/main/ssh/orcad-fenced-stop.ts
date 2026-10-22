import {
  ORCAD_UPDATE_ADMISSION_FENCE_MS,
  ORCAD_UPDATE_ADMISSION_STOP_BY_MS,
  type OrcadTerminalCensus,
  UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
} from '../../shared/orcad-terminal-census'
import type { OrcadTerminalCensusRequestOptions } from './orcad-terminal-census-client'

/**
 * The counts an update, rollback or restart makes against one incumbent. Only the last, just
 * before the stop, closes its terminal admission: an update's first precedes a long upload.
 */
export function updateTerminalCounts(
  count: (options: OrcadTerminalCensusRequestOptions) => Promise<OrcadTerminalCensus>
): {
  countFirst: () => Promise<OrcadTerminalCensus>
  recountCensus: () => Promise<OrcadTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
} {
  // Why release: finished automation shells would otherwise defer every update on a host with
  // schedules; the update restarts the server anyway.
  const release = { releaseFinishedAutomationTerminals: true }
  return {
    countFirst: () => count(release),
    recountCensus: () =>
      count({ ...release, closeAdmissionForMs: ORCAD_UPDATE_ADMISSION_FENCE_MS }),
    releaseIncumbentAdmission: async () => {
      await count({ closeAdmissionForMs: 0 })
    }
  }
}

/** One update, rollback or restart stopping its incumbent behind the terminal admission fence. */
export type FencedStop<Stopped, Refused> = {
  /** Counts again, closing admission; called under the host lock, so no peer's fence is touched. */
  recountCensus: () => Promise<OrcadTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
  now: () => number
  /** Why this count refuses the stop, or null to go ahead. */
  refuse: (census: OrcadTerminalCensus) => Refused | null
  /** What must land between the count and the stop, such as the journal. */
  prepare?: () => Promise<void>
  /** The refusal once the count may have outlived its fence. */
  stale: () => Refused
  /** `stillFenced` is for reads that run before the stop is actually sent. */
  stop: (stillFenced: () => boolean) => Promise<Stopped>
  /** Whether the stop may have been sent; if not, the server keeps serving and admission reopens. */
  stopMayHaveBeenSent: (stopped: Stopped) => boolean
}

/**
 * Count, close, stop, and reopen on abort: the one sequence every flow that stops a server over
 * live terminals follows. A throw from `stop` may hide a stop still on its way, so admission then
 * stays closed and lapses on its own; once the server sees the stop it holds admission until exit.
 */
export async function runFencedStop<Stopped, Refused>(
  fence: FencedStop<Stopped, Refused>
): Promise<{ refused: Refused } | { stopped: Stopped }> {
  // Before the count goes out, so the deadline errs early against the server's fence.
  const stopBy = fence.now() + ORCAD_UPDATE_ADMISSION_STOP_BY_MS
  const reopen = (): Promise<void> => fence.releaseIncumbentAdmission().catch(() => {})
  const refusal = fence.refuse(
    await fence.recountCensus().catch(() => UNVERIFIABLE_ORCAD_TERMINAL_CENSUS)
  )
  if (refusal !== null) {
    await reopen()
    return { refused: refusal }
  }
  try {
    await fence.prepare?.()
  } catch (error) {
    await reopen()
    throw error
  }
  if (fence.now() > stopBy) {
    await reopen()
    return { refused: fence.stale() }
  }
  const stopped = await fence.stop(() => fence.now() <= stopBy)
  if (!fence.stopMayHaveBeenSent(stopped)) {
    await reopen()
  }
  return { stopped }
}
