export type SpanLifecycleObserver = {
  started: (spanId: string, name: string, startedAt: number) => void
  ended: (spanId: string) => void
}

const observers = new Set<SpanLifecycleObserver>()

export function subscribeSpanLifecycle(observer: SpanLifecycleObserver): () => void {
  observers.add(observer)
  return () => observers.delete(observer)
}

export function notifySpanStarted(spanId: string, name: string, startedAt: number): void {
  for (const observer of observers) {
    try {
      observer.started(spanId, name, startedAt)
    } catch {
      // Optional diagnostics must not interrupt the observed operation.
    }
  }
}

export function notifySpanEnded(spanId: string): void {
  for (const observer of observers) {
    try {
      observer.ended(spanId)
    } catch {
      // Optional diagnostics must not interrupt the observed operation.
    }
  }
}
