import type { RecordedValue, Settlement } from './recording-values'

export type NativeObservation = {
  name: string
  method: string
  parent?: string
  ordinal: number
  args: RecordedValue
  settlement: Settlement
  afterArgs?: RecordedValue
  wait?: {
    ordinal: number
    startedAt: number
    outcome?: {
      status: 'fulfilled' | 'rejected'
      ordinal: number
      at: number
      error?: RecordedValue
    }
  }
  allocation?: { id: string; ordinal: number }
  frame?: { id: string; ordinal: number }
  completion?: { ordinal: number; reply: RecordedValue; resolved: boolean }
  lateReplies?: { ordinal: number; reply: RecordedValue; resolved: false }[]
  terminalOrdinal?: number
}
export type BridgeReceiptObservation = {
  parent: string
  pair: number
  document: number
  post: number
  id?: string
  json: string
  ordinal: number
  enqueued?: number
  deliveries: number[]
  replies: {
    json: string
    ordinal: number
    delivered?: string
    deliveryOrdinal?: number
  }[]
  children: NativeObservation[]
}
export type BridgePostObservation = BridgeReceiptObservation & {
  id: string
  receipts?: BridgeReceiptObservation[]
}
export type AttemptObservation = {
  name: string
  ordinal: number
  args: RecordedValue
  settlement: Settlement
  bridge?: {
    page?: {
      pair: number
      document: number
      afterArgs?: RecordedValue
      didThrow?: boolean
      refusal?: string
      error?: RecordedValue
    }
    posts: BridgePostObservation[]
  }
}
export type Attempt = {
  kind: 'attempt'
  observation: AttemptObservation
  method: string
  native: NativeObservation[]
  bridge: boolean
  originalArgs?: readonly unknown[]
}
export type Message = { kind: 'message'; attempt: Attempt; observation: BridgeReceiptObservation }
export type Reply = {
  kind: 'reply'
  message: Message
  entry: BridgePostObservation['replies'][number]
}
export type Parent = Attempt | Message | Reply | { kind: 'other' }
