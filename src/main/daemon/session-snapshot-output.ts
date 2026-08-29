import type { TakePendingOutputResult, TerminalSnapshot } from './types'

export function takeSessionPendingOutput(args: {
  disposed: boolean
  includeSnapshot: boolean
  teardownSnapshot: boolean
  prepareForFinalSnapshot: () => string
  takePendingOutput: (
    includeSnapshot: boolean,
    releasedHeldBytes: string,
    getSnapshot: () => TerminalSnapshot | null
  ) => TakePendingOutputResult | null
  getSnapshot: () => TerminalSnapshot | null
}): TakePendingOutputResult | null {
  if (args.disposed) {
    return null
  }
  const releasedHeldBytes =
    args.includeSnapshot && args.teardownSnapshot ? args.prepareForFinalSnapshot() : ''
  return args.takePendingOutput(args.includeSnapshot, releasedHeldBytes, args.getSnapshot)
}

export function prepareSessionFinalSnapshot(args: {
  releaseHeldBytes: () => string
  snapshotIngressBarrier: () => void
  flushRecoveryBarrier: () => void
}): string {
  const held = args.releaseHeldBytes()
  args.snapshotIngressBarrier()
  args.flushRecoveryBarrier()
  return held
}
