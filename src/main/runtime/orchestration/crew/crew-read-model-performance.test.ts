import { afterEach, expect, it, vi } from 'vitest'

import { CrewReadModel } from './crew-read-model'

import { fixture } from './crew-read-model.test-fixture'

afterEach(() => vi.useRealTimers())

it.each([
  ['x'.repeat(1024), 'x'.repeat(1024)],
  ['x'.repeat(1025), `${'x'.repeat(1021)}…`],
  [`${'x'.repeat(1020)}🙂tail`, `${'x'.repeat(1020)}…`],
  [`${'x'.repeat(1017)}🙂tail`, `${'x'.repeat(1017)}🙂…`]
])('preserves the existing UTF-8 preview boundary for %#', (body, expected) => {
  const { db, deps, run, assign } = fixture()
  const dispatch = assign('term_worker')
  db.createQuestion({
    runId: run.id,
    dispatchId: dispatch.id,
    askerHandle: 'term_worker',
    question: body
  })
  const row = new CrewReadModel(() => deps, db.crewChanges.subscribe).read('term_coord').sections
    .managing[0]
  expect(row.latest?.preview).toBe(expected)
  expect(row.pendingQuestion?.preview).toBe(expected)
})
