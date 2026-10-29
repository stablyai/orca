import type { SessionChangeSet, SessionUnitChange } from '../../../shared/session-change-set'

export function mergeSessionChanges(events: readonly SessionChangeSet[]): SessionChangeSet {
  const latest = events.at(-1)!
  const units = new Map<string, SessionUnitChange>()
  const owners = new Set<string>(),
    tabs = new Set<string>(),
    panes = new Set<string>()
  const files = new Set<string>(),
    pages = new Set<string>(),
    repos = new Set<string>()
  const editorViews = new Map<string, { prior: unknown; next: unknown }>()
  for (const event of events) {
    for (const [key, change] of event.editorViews ?? []) {
      const first = editorViews.get(key)
      editorViews.set(key, { prior: first ? first.prior : change.prior, next: change.next })
    }
    for (const unit of event.units) {
      const id = JSON.stringify([unit.field, unit.key])
      const previous = units.get(id)
      units.set(
        id,
        previous ? { ...unit, prior: previous.prior, priorPresent: previous.priorPresent } : unit
      )
    }
    for (const [field, target] of [
      ['owners', owners],
      ['tabs', tabs],
      ['panes', panes],
      ['files', files],
      ['pages', pages],
      ['repos', repos]
    ] as const) {
      for (const id of event[field]) {
        target.add(id)
      }
    }
  }
  return {
    ...latest,
    fullReplacement: events.some((event) => event.fullReplacement),
    units: [...units.values()],
    owners,
    tabs,
    panes,
    files,
    pages,
    repos,
    editorViews
  }
}
