import type { RpcClient } from '../../transport/rpc-client'
import type { RecordedValue } from './recording-values'

export type RpcRequestSender = Pick<RpcClient, 'sendRequest'>
export type Rejection = {
  message: string
  category?: 'Error' | 'TypeError'
  deliveryUnknown?: boolean
}
export type ScenarioStep =
  | { action: string; id: string; args?: Record<string, unknown> }
  | { complete: string; params: unknown; reply?: unknown; reject?: Rejection }
  | { bind: string; request: string; params: unknown }
  | { advance: number }
  | { checkpoint: string }
export type RecordingScenario = {
  id: string
  operation: string
  version: number
  family: string
  sites: string[]
  schedules: string[]
  namedDeltas?: string[]
  steps: ScenarioStep[]
}
export type MountedOperation = {
  action: (name: string, args: Record<string, unknown>) => unknown
  state: () => unknown
  dispose: () => void | Promise<void>
}
export type MountContext = {
  client: RpcClient
  effect: (name: string, value: unknown) => void
}
export type MountAdapter = (context: MountContext) => MountedOperation
export type RecordingScheduler = {
  start: () => void
  flush: () => Promise<void>
  advance: (ms: number) => Promise<void>
  stop: () => void
}
export type Observation = {
  sender: RecordedValue
  payloads: RecordedValue
  settlements: RecordedValue
  state: RecordedValue
  effects: RecordedValue
}
export type Recording = {
  scenario: string
  checkpoints: { id: string; observation: Observation }[]
}
