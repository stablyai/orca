import type { SynchronizedOutputLatchState } from '../../../../shared/terminal-synchronized-output-scan'
import type { Mode2031ReplyScanState } from '../../../../shared/terminal-color-scheme-protocol'

export type PendingPtyData = {
  data: string
  startSeq?: number
  rawLength?: number
  transformed?: true
  containsBackgroundOutput?: boolean
  droppedOutput?: true
  droppedMode2031Data?: string
  droppedMode2031ScanState?: Mode2031ReplyScanState
  /** Preserve synchronized-output state across dropped bytes, including a lost closing escape that would hold rendering. */
  droppedSynchronizedOutputState?: SynchronizedOutputLatchState
}

export type PtyPendingDataDrainDisposition = 'active' | 'background' | 'blocked'

type DrainPhase = 'active' | 'background' | 'done'

export type PtyPendingDataDrainRound = {
  readonly round: number
  activeFrontier: number
  backgroundFrontier: number
  phase: DrainPhase
  aborted: boolean
}

export type PtyPendingDataDrainSelection = Readonly<{ id: string; pending: PendingPtyData }>
