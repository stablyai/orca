import {
  crewSummary,
  emptyCrew,
  type OrchestrationCrewFrame,
  type OrchestrationCrewRow,
  type OrchestrationCrewSnapshot
} from '../../../../shared/orchestration/orchestration-crew'

const SECTIONS = ['managedBy', 'managing', 'talkingWith'] as const

export function subscribeCrew(
  read: () => OrchestrationCrewSnapshot,
  watch: (wake: () => void) => () => void,
  emit: (frame: OrchestrationCrewFrame) => void,
  /** `summary` sends the counts a closed strip shows, and only when they change. */
  view: 'summary' | 'rows' = 'rows',
  /** After the first snapshot, send only changed rows and each section's order. */
  deltas = false
): () => void {
  let alive = true
  let queued = false
  let previous: string | undefined
  /** The serialized rows last sent, by section and party key; null until a snapshot was sent. */
  let sent: Map<string, string> | null = null
  let sentStatus: string | undefined
  let sentOrder: string | undefined
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
    if (view === 'summary') {
      const summary = crewSummary(snapshot)
      const key = `${summary.status}:${summary.agents}:${summary.needsYou}`
      if (key !== previous) {
        previous = key
        emit({ type: 'summary', ...summary })
      }
      return
    }
    if (deltas && publishDelta(snapshot)) {
      return
    }
    sent = null
    const serialized = JSON.stringify(snapshot)
    if (serialized === previous) {
      return
    }
    previous = serialized
    publishWhole(snapshot)
  }
  const publishWhole = (snapshot: OrchestrationCrewSnapshot) => {
    emit({ type: 'begin', status: snapshot.status })
    for (const section of SECTIONS) {
      for (const row of snapshot.sections[section]) {
        // Previews are byte-bounded; one allow-listed row fits comfortably in one frame.
        emit({ type: 'rows', section, rows: [row] })
      }
    }
    emit({ type: 'complete' })
  }
  /** False when a party shows twice in one section, which has no key to patch by. */
  const publishDelta = (snapshot: OrchestrationCrewSnapshot): boolean => {
    const rows = new Map<string, string>()
    const changed: { section: (typeof SECTIONS)[number]; row: OrchestrationCrewRow }[] = []
    for (const section of SECTIONS) {
      for (const row of snapshot.sections[section]) {
        const key = `${section}\0${row.partyKey}`
        const serialized = JSON.stringify(row)
        if (rows.has(key)) {
          return false
        }
        rows.set(key, serialized)
        if (sent?.get(key) !== serialized) {
          changed.push({ section, row })
        }
      }
    }
    const order = {
      managedBy: snapshot.sections.managedBy.map((row) => row.partyKey),
      managing: snapshot.sections.managing.map((row) => row.partyKey),
      talkingWith: snapshot.sections.talkingWith.map((row) => row.partyKey)
    }
    const orderKey = JSON.stringify(order)
    const whole = sent === null
    if (
      !whole &&
      changed.length === 0 &&
      orderKey === sentOrder &&
      snapshot.status === sentStatus
    ) {
      return true
    }
    sent = rows
    sentOrder = orderKey
    sentStatus = snapshot.status
    previous = undefined
    if (whole) {
      publishWhole(snapshot)
      return true
    }
    emit({ type: 'delta', status: snapshot.status, order })
    for (const { section, row } of changed) {
      emit({ type: 'rows', section, rows: [row] })
    }
    emit({ type: 'complete' })
    return true
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
