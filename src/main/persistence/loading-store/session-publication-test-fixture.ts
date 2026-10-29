import { expect } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { publishSessionChanges, sessionPublication } from './session-publication'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import { scheduleSave } from './write-scheduling'
import type { Store } from './store'

function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return
  }
  for (const child of Object.values(value)) {
    freeze(child)
  }
  Object.freeze(value)
}

/** Exercise authoritative publication while retaining a frozen snapshot for each concurrent edit. */
export function editPublishedFixture(
  store: Store,
  edit: (candidate: WorkspaceSessionState) => void
): void {
  const prior = store.getWorkspaceSession()
  const original = structuredClone(prior)
  freeze(prior)
  const next = structuredClone(prior)
  edit(next)
  const reader = SessionUnitReader.between(
    prior,
    next,
    sessionPublication(store['runtime'].state).partition('local').index
  )
  publishSessionChanges(store['runtime'].state, 'local', reader.prepare({ kind: 'authoritative' }))
  scheduleSave(store, ['workspaceSession'], 'local')
  expect(prior).toEqual(original)
}
