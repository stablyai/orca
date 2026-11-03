import type { TerminalSubscribe } from '../../../src/shared/rpc-contract/terminal-stream-params'

export type Listener = (result: unknown) => unknown
export type Stream = {
  params: ReturnType<typeof TerminalSubscribe.parse>
  listener: Listener
  stopLegacy?: () => void
  subscribed: boolean
  bytes: number
  frames: number
  snapshotBytes: number
  snapshotFrames: number
}

export function isTerminalStreamEvent(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  )
}
