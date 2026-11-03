import type {
  BridgeTerminalOutputBacklog,
  TerminalBacklogEnd
} from './bridge-terminal-output-backlog'

export type UnackedFrame = {
  seq: number
  bytes: number
  applied?: () => void
  rejected?: () => void
}

export type OpenSubscription = {
  unsubscribe: () => void
  seq: number
  unacked: UnackedFrame[]
  unackedBytes: number
  droppedFrames: number
  backlog: BridgeTerminalOutputBacklog | null
  applicationReceipts: boolean
}
export type BridgeTerminalBacklogReport = {
  id: string
  coalescedFrames: number
  deliveredFrames: number
  peakPendingBytes: number
  ended: TerminalBacklogEnd | null
}

export type BridgeDroppedBinaryFrame = {
  id: string
  bytes: number
  droppedOnStream: number
}
