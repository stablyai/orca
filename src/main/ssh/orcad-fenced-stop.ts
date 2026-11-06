import {
  ORCAD_UPDATE_ADMISSION_FENCE_MS,
  ORCAD_UPDATE_ADMISSION_STOP_BY_MS,
  type OrcadTerminalCensus,
  UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
} from '../../shared/orcad-terminal-census'
import type { OrcadTerminalCensusRequestOptions } from './orcad-terminal-census-client'

/** Only the final count closes terminal admission: the initial update census may precede a long upload. */
export function updateTerminalCounts(
  count: (options: OrcadTerminalCensusRequestOptions) => Promise<OrcadTerminalCensus>
): {
  countFirst: () => Promise<OrcadTerminalCensus>
  recountCensus: () => Promise<OrcadTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
} {
  // Release finished automation shells or scheduled hosts would defer every update; the server restarts anyway.
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

export type FencedStop<Stopped, Refused> = {
  /** Counts again, closing admission; called under the host lock, so no peer's fence is touched. */
  recountCensus: () => Promise<OrcadTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
  now: () => number
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

/** Keep admission closed when a thrown stop may still arrive; otherwise reopen on abort. The server holds admission through exit after receiving the stop. */
export async function runFencedStop<Stopped, Refused>(
  fence: FencedStop<Stopped, Refused>
): Promise<{ refused: Refused } | { stopped: Stopped }> {
  // Start the deadline before recount so it expires before the server's admission fence.
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
