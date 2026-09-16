import type { RpcClient } from '../../transport/rpc-client'
import type { DeclaredDeviceState } from './declared-device-state'
import type { RecordedValue } from './recording-values'

export type RpcRequestSender = Pick<RpcClient, 'sendRequest'>
export type Rejection = {
  message: string
  category?: 'Error' | 'TypeError'
  deliveryUnknown?: boolean
}
/**
 * `optional` belongs to generated steps only: a matrix variant answers one request differently, so
 * the requests scripted after it may never be sent. Skipping one the operation never asked for
 * records what it actually did; a scripted step the manifest declares is never optional. A frame
 * carries no such flag — the registry routes every streaming response to the id that opened the
 * stream, so a frame after a divergence is always deliverable.
 *
 * `frame` names the subscribe payload it is delivered on and carries a whole host response, which
 * the real stream registry routes — `ready`, a data event, `end` and a refusal are all one kind.
 * `params` asserts the subscribe params, the same contract `complete` holds for a request.
 */
export type ScenarioStep =
  | { action: string; id: string; args?: Record<string, unknown> }
  | { complete: string; params: unknown; reply?: unknown; reject?: Rejection; optional?: true }
  | { frame: string; params: unknown; reply: unknown }
  | { bind: string; request: string; params: unknown; optional?: true }
  | { advance: number }
  | { checkpoint: string }
/** A scenario may declare device state; see `declared-device-state.ts` for what a declaration buys. */
export type RecordingScenario = DeclaredDeviceState & {
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
