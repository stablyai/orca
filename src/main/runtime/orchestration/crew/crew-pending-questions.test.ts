import { expect, it } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { buildCrewSnapshot } from './crew-party-snapshot'

it('decorates handed-back peer questions after row creation without flattening direct children', () => {
  const { db, deps, run, assign } = fixture()
  const parent = assign('term_worker')
  const helper = assign('term_helper', 'term_worker')
  const question = db.createQuestion({
    runId: run.id,
    dispatchId: helper.id,
    askerHandle: 'term_helper',
    to: `dispatch:${parent.id}`,
    question: 'Choose the helper option?'
  })
  db.completeDispatch(parent.id)
  expect(db.getMessageById(question.message.id)?.to_handle).toBe(`run:${run.id}`)
  const snapshot = buildCrewSnapshot('term_coord', deps)
  expect(snapshot.sections.managing.map((row) => row.sendAddress)).toEqual(['term_worker'])
  expect(snapshot.sections.talkingWith).toHaveLength(1)
  expect(snapshot.sections.talkingWith[0].pendingQuestion?.preview).toBe(
    'Choose the helper option?'
  )
  expect(db.getQuestion(question.message.id)?.status).toBe('pending')
})
