import type { Mode2031ReplyScanState } from '../../shared/terminal-color-scheme-protocol'

export type PendingPtyData = {
  data: string
  startSeq?: number
  rawLength?: number
  transformed?: true
  containsBackgroundOutput?: boolean
  droppedOutput?: true
  denseSgrDrop?: true
  droppedMode2031Data?: string
  droppedMode2031ScanState?: Mode2031ReplyScanState
  projectionAdmissionIds?: readonly string[]
  projectionAdmissionsTransferred?: true
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
