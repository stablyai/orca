import type { SubprocessHandle } from './session-subprocess-handle'
export type TerminalSpawnAttempt = {
  discard(): Promise<void>
  failure?: { error: unknown }
}

export type ObserveTerminalSpawnAttempt = (
  createHandle: () => SubprocessHandle,
  discardNative: () => Promise<void>
) => TerminalSpawnAttempt
