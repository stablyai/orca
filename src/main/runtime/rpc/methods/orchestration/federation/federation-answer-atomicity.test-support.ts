import { expect, it } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcDispatcher } from '../../../dispatcher'
import { createFederationWorkerStartRequest as startRequest } from './federation-request.test-support'

export function registerFederationAnswerAtomicityTest(
  fixture: () => {
    homeDb: OrchestrationDb
    workerDb: OrchestrationDb
    homeRuntime: OrcaRuntimeService
    homeDispatcher: RpcDispatcher
    createHomeTask: () => ReturnType<OrchestrationDb['createTask']>
  }
): void {
  it('commits imported answer, snapshot and cursor together and keeps first absent identity immutable', async () => {
    const { workerDb, homeDb, homeRuntime, homeDispatcher, createHomeTask } = fixture()
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    workerDb.enqueueFederationRelay({
      dispatchId: dispatch.id,
      direction: 'to_home',
      kind: 'question',
      payload: '{}',
      messageId: 'question-atomic',
      remoteQuestion: true
    })
    workerDb.insertMessage({
      id: 'answer-atomic',
      runId: task.run_id,
      from: 'other',
      to: 'other',
      subject: 'Collision'
    })
    const item = {
      dispatch_id: dispatch.id,
      direction: 'to_worker',
      sequence: 1,
      message_id: 'relay-answer',
      kind: 'reply',
      payload: JSON.stringify({
        questionId: 'question-atomic',
        answerMessageId: 'answer-atomic',
        body: 'yes'
      }),
      answerSenderReport: { version: 1, name: 'Known A', agent: 'codex' }
    }
    const send = (
      id: string,
      value: Omit<typeof item, 'answerSenderReport'> & {
        answerSenderReport?: typeof item.answerSenderReport
      } = item
    ) =>
      homeRuntime.callOrchestrationWorkerServer(
        'environment_windows',
        'orchestration.federationImport',
        { dispatchId: dispatch.id, items: [value] },
        5000,
        { orchestrationRequestId: id }
      )
    await expect(send('collision')).rejects.toThrow('conflicts with an existing message')
    expect(workerDb.getRemoteQuestion('question-atomic')?.status).toBe('pending')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.to_worker_imported_sequence).toBe(0)
    workerDb.db.prepare('DELETE FROM messages WHERE id = ?').run('answer-atomic')
    workerDb.db.exec(
      "CREATE TRIGGER reject_cursor BEFORE UPDATE OF to_worker_imported_sequence ON remote_dispatch_attachments BEGIN SELECT RAISE(ABORT, 'cursor blocked'); END"
    )
    await expect(send('cursor-failure')).rejects.toThrow('cursor blocked')
    expect(workerDb.getMessageById('answer-atomic')).toBeUndefined()
    expect(workerDb.getRemoteQuestion('question-atomic')?.status).toBe('pending')
    workerDb.db.exec('DROP TRIGGER reject_cursor')
    workerDb.db.exec(
      'CREATE TRIGGER ignore_answer BEFORE UPDATE OF status ON remote_questions BEGIN SELECT RAISE(IGNORE); END'
    )
    await expect(send('answer-no-op')).rejects.toThrow('remote answer could not be stored')
    expect(workerDb.getMessageById('answer-atomic')).toBeUndefined()
    expect(workerDb.getRemoteQuestion('question-atomic')?.status).toBe('pending')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.to_worker_imported_sequence).toBe(0)
    workerDb.db.exec('DROP TRIGGER ignore_answer')
    const { answerSenderReport: _report, ...withoutReport } = item
    await send('accepted-without', withoutReport)
    expect(workerDb.getMessageById('answer-atomic')?.answer_sender_snapshot).toBeNull()
    await send('replay-with-report', item)
    expect(workerDb.getMessageById('answer-atomic')?.answer_sender_snapshot).toBeNull()
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.to_worker_imported_sequence).toBe(1)
  })
}
