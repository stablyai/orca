import {
  emptyCrew,
  type OrchestrationCrewFrame,
  type OrchestrationCrewSnapshot
} from '../../../../shared/orchestration-crew'

export function subscribeCrew(
  read: () => OrchestrationCrewSnapshot,
  watch: (wake: () => void) => () => void,
  emit: (frame: OrchestrationCrewFrame) => void
): () => void {
  let alive = true
  let queued = false
  let previous: string | undefined
  const publish = () => {
    if (!alive) {
      return
    }
    let snapshot: OrchestrationCrewSnapshot
    try {
      snapshot = read()
    } catch {
      snapshot = emptyCrew('unknown')
    }
    const serialized = JSON.stringify(snapshot)
    if (serialized === previous) {
      return
    }
    previous = serialized
    emit({ type: 'begin', status: snapshot.status })
    for (const section of ['managedBy', 'managing', 'talkingWith'] as const) {
      for (const row of snapshot.sections[section]) {
        // Previews are byte-bounded; one allow-listed row fits comfortably in one frame.
        emit({ type: 'rows', section, rows: [row] })
      }
    }
    emit({ type: 'complete' })
  }
  const unwatch = watch(() => {
    if (queued) {
      return
    }
    queued = true
    queueMicrotask(() => {
      queued = false
      publish()
    })
  })
  publish()
  return () => {
    alive = false
    unwatch()
  }
}
