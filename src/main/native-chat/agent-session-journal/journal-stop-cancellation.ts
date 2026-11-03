import type { JournalStopEvent } from './journal-row-schema'

type RecordedStop = { sequence: number; event: JournalStopEvent }

const besideHoldingStop = new Map<string, RecordedStop>()

function holdingKey(scope: { sessionId: string; epoch: string }, sequence: number): string {
  return `${scope.sessionId}\0${scope.epoch}\0${sequence}`
}

/** A new journal for this chat drops closes remembered only in this process. */
export function forgetStopCancellations(scope: { sessionId: string; epoch: string }): void {
  const prefix = `${scope.sessionId}\0${scope.epoch}\0`
  for (const key of besideHoldingStop.keys()) {
    if (key.startsWith(prefix)) {
      besideHoldingStop.delete(key)
    }
  }
}

/** A close during a personal Stop, keyed by that Stop. The Stop itself is not stored again. */
export function rememberStopCancellation(
  scope: { sessionId: string; epoch: string },
  holdingSequence: number,
  recorded: RecordedStop
): void {
  besideHoldingStop.set(holdingKey(scope, holdingSequence), recorded)
}

/** Undefined: this process has not seen a distinct close for the Stop. */
export function stopCancellationBeside(
  scope: { sessionId: string; epoch: string },
  latest: RecordedStop | null
): RecordedStop | undefined {
  if (latest === null) {
    return undefined
  }
  return besideHoldingStop.get(holdingKey(scope, latest.sequence))
}
