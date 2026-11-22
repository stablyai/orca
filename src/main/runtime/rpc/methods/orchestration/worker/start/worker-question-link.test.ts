import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { getQuestionTaker } from '../../../../../orchestration/db/messages/mail-taker'
import { linkWorkerToQuestion, openQuestionReminder } from './worker-question-link'
import { testOrcaSessionId } from '../../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'

const caller = {
  address: 'term_docs',
  terminalHandle: 'term_docs',
  paneKey: 'tab-1:leaf-1',
  orcaSessionId: null
}

describe('worker-start --for', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function question(to: string, root: string, record = '{}'): string {
    const admitted = db.admitBotRequest({
      rootKey: root,
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record,
      message: { from: 'orca_session_id:asker', to, subject: root, type: 'question' }
    })
    return admitted.kind === 'sent' ? admitted.message.id : ''
  }

  it('links a question the caller took', () => {
    const id = question('term_docs', 'taken')
    db.markAsRead([id], { kind: 'terminal', handle: 'term_docs' })
    expect(linkWorkerToQuestion(db, id, caller, false)).toEqual({ question: id, linked: true })
  })

  it('links a question still on its way to the caller, and records the take once a worker starts', () => {
    const id = question('term_docs', 'arriving')
    const link = linkWorkerToQuestion(db, id, caller, false)
    expect(link).toMatchObject({ question: id, linked: true })
    expect(getQuestionTaker(db, id)).toBeNull()
    expect(link.linked && link.take?.(true)).toEqual({ question: id, linked: true })
    expect(getQuestionTaker(db, id)).toBe('terminal:term_docs')
  })

  it('records no take when the start produced no worker', () => {
    const id = question('term_docs', 'failed')
    const link = linkWorkerToQuestion(db, id, caller, false)
    expect(link.linked && link.take?.(false)).toEqual({
      question: id,
      linked: false,
      why: `no worker started for ${id}`
    })
    expect(getQuestionTaker(db, id)).toBeNull()
  })

  it('reports no link when someone else took the question while the worker started', () => {
    const id = question('term_docs', 'raced')
    const link = linkWorkerToQuestion(db, id, caller, false)
    db.markAsRead([id], { kind: 'terminal', handle: 'term_other' })
    expect(link.linked && link.take?.(true)).toEqual({
      question: id,
      linked: false,
      why: `${id} was taken by someone else while the worker started`
    })
  })

  it("links a question sent to the caller's own Dispatch mailbox", () => {
    const task = db.createTask({ spec: 'parent work', runId: 'run_legacy_local' })
    const parent = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskId: task.id,
      startOptions: {}
    })
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
      .run('term_docs', parent.dispatch.id)
    const id = question(`dispatch:${parent.dispatch.id}`, 'helper')
    expect(linkWorkerToQuestion(db, id, caller, false)).toMatchObject({
      question: id,
      linked: true
    })
  })

  it('links a structured worker to the question its chat took', () => {
    const id = question('term_docs', 'card')
    const session = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
    db.markAsRead([id], { kind: 'session', sessionId: session })
    const structured = { ...caller, orcaSessionId: session }
    expect(linkWorkerToQuestion(db, id, structured, false)).toEqual({ question: id, linked: true })
  })

  it('does not link a question read before Orca recorded who took it', () => {
    const id = question('term_docs', 'old')
    db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(id)
    expect(linkWorkerToQuestion(db, id, caller, false)).toEqual({
      question: id,
      linked: false,
      why: `${id} was read before Orca recorded who took it`
    })
  })

  it("starts unlinked, saying why, for someone else's question, a paired worker or other mail", () => {
    const elsewhere = question('term_other', 'elsewhere')
    const takenByOther = question('term_docs', 'other')
    db.markAsRead([takenByOther], { kind: 'terminal', handle: 'term_other' })
    const note = db.insertMessage({ from: 'a', to: 'term_docs', subject: 'fyi' })

    const why = (id: string, paired = false) => {
      const link = linkWorkerToQuestion(db, id, caller, paired)
      return link.linked ? 'linked' : link.why
    }
    expect(why(elsewhere)).toBe(`${elsewhere} was not sent to you`)
    expect(why(takenByOther)).toBe(`${takenByOther} was taken by someone else`)
    expect(why(note.id)).toBe(`${note.id} is not a question this Orca holds`)
    expect(why(elsewhere, true)).toBe("a worker on a paired computer can't be linked to a question")
    expect(getQuestionTaker(db, elsewhere)).toBeNull()
  })

  it('keeps the link on the worker it starts', () => {
    const id = question('term_docs', 'kept')
    const started = db.createStartingWorkerDispatch({
      taskSpec: 'Find the answer',
      taskRunId: 'run_legacy_local',
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 10,
      forMessageId: id
    })
    expect(db.getDispatchContextById(started.dispatch.id)?.for_message_id).toBe(id)
  })

  it('reminds a caller that took a question it has not answered to pass --for, and no one else', () => {
    const ranger = JSON.stringify({ fromBotName: 'Ranger', toBotName: 'Docs', purpose: 'question' })
    const id = question('term_docs', 'open', ranger)
    expect(openQuestionReminder(db, caller)).toBeUndefined()
    db.markAsRead([id], { kind: 'terminal', handle: 'term_docs' })
    expect(openQuestionReminder(db, caller)).toBe(
      `You have an open question from Ranger (${id}). If this worker is for it, add --for ${id}.`
    )
    expect(
      openQuestionReminder(db, { ...caller, address: 'term_x', terminalHandle: 'term_x' })
    ).toBeUndefined()
    db.recordBotAnswer(id)
    expect(openQuestionReminder(db, caller)).toBeUndefined()
  })

  it("reminds a coordinator holding its worker's unanswered question", () => {
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_docs',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ spec: 'work', runId: run.id })
    const worker = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskId: task.id,
      startOptions: {}
    })
    const { message } = db.createQuestion({
      runId: run.id,
      dispatchId: worker.dispatch.id,
      askerHandle: 'term_w',
      question: 'Which font?'
    })
    db.markAsRead([message.id], { kind: 'terminal', handle: 'term_docs' })
    expect(openQuestionReminder(db, caller)).toBe(
      `You have an open question from your worker on Dispatch ${worker.dispatch.id} (${message.id}). If this worker is for it, add --for ${message.id}.`
    )
  })
})
