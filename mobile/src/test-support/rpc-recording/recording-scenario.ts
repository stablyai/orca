import type { RpcClient } from '../../transport/rpc-client'
import type { DeclaredDeviceState } from './declared-device-state'
import type { RecordedValue } from './recording-values'

export type RpcRequestSender = Pick<RpcClient, 'sendRequest'>
export type Rejection = {
  message: string
  category?: 'Error' | 'TypeError'
  deliveryUnknown?: boolean
}
// Only generated completions may be optional after a divergence; manifest steps remain required.
// Streaming frames always route to their opening id, assert subscribe params and carry whole host responses.
export type ScenarioStep =
  | { action: string; id: string; args?: Record<string, unknown> }
  | { complete: string; params: unknown; reply?: unknown; reject?: Rejection; optional?: true }
  | { frame: string; params: unknown; reply: unknown }
  | { bind: string; request: string; params: unknown; optional?: true }
  | { advance: number }
  | { checkpoint: string }
export type RecordingScenario = DeclaredDeviceState & {
  id: string
  operation: string
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
  /** Awaited: the scheduler pays React's one lazy `Math.random()` draw here, off the seeded run. */
  start: () => Promise<void>
  flush: () => Promise<void>
  advance: (ms: number) => Promise<void>
  /** Virtual milliseconds since the pinned recording epoch. */
  elapsed: () => number
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
