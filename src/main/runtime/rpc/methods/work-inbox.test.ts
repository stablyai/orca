import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { workInboxStoreFor } from '../../work-inbox/work-inbox-service'
import { WORK_INBOX_METHODS } from './work-inbox'

vi.mock('../../structured-worker-authority', () => ({
  readStructuredAgentSessionRecord: () => null
}))
const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})
function fixture() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const store = workInboxStoreFor(db)
  const item = store.create({
    asker: {
      handle: 'original-agent',
      paneKey: null,
      projectId: null,
      projectLabel: null,
      worktreeId: null,
      agentKind: 'codex'
    },
    question: 'Approve?',
    optionLabels: ['Yes (recommended)'],
    allowFreeText: true,
    now: 1
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Resume and human mutations only call getOrchestrationDb on this fixture.
  const runtime = { getOrchestrationDb: () => db } as OrcaRuntimeService
  const context: RpcContext = { runtime, caller: { kind: 'desktop' } }
  return { store, item, context }
}
describe('Work Inbox human closure contract', () => {
  it('wakes the original asking AI with no answer and explicit non-approval even after immediate reopen', async () => {
    const { item, store, context } = fixture()
    const ask = WORK_INBOX_METHODS.find((method) => method.name === 'workInbox.ask')!
    const cancel = WORK_INBOX_METHODS.find((method) => method.name === 'workInbox.cancel')!
    const reopen = WORK_INBOX_METHODS.find((method) => method.name === 'workInbox.reopen')!
    const waiting = ask.handler(
      ask.params.parse({ from: item.agentId, resume: item.id, timeoutMs: 1000 }),
      context
    )
    const closed = cancel.handler(
      cancel.params.parse({ id: item.id, expectedRevision: 0 }),
      context
    )
    await reopen.handler(reopen.params.parse({ id: item.id, expectedRevision: 1 }), context)
    await closed
    expect(await waiting).toMatchObject({
      id: item.id,
      status: 'cancelled',
      cancelled: true,
      answer: null,
      timedOut: false,
      message: expect.stringContaining('not approval')
    })
    expect(store.get(item.id)?.status).toBe('open')
    await expect(
      ask.handler({ from: 'different-agent', resume: item.id, timeoutMs: 1 }, context)
    ).rejects.toThrow('another agent')
  })
  it('rejects CLI dismissal/reopen and acknowledges no fabricated answer', async () => {
    const { item, context } = fixture()
    const mutations = WORK_INBOX_METHODS.filter(
      (candidate) => candidate.name === 'workInbox.cancel' || candidate.name === 'workInbox.reopen'
    )
    for (const method of mutations) {
      await expect(
        method.handler(method.params.parse({ id: item.id, expectedRevision: 0 }), {
          ...context,
          caller: { kind: 'local-cli' }
        })
      ).rejects.toThrow('only from the Orca app')
      expect(method.params.safeParse({ id: item.id, expectedRevision: -1 }).success).toBe(false)
    }
  })
  it('rejects CLI answers and acknowledgement by another asker', async () => {
    const { item, context } = fixture()
    const answer = WORK_INBOX_METHODS.find((method) => method.name === 'workInbox.answer')!
    const ack = WORK_INBOX_METHODS.find((method) => method.name === 'workInbox.ack')!
    await expect(
      answer.handler(
        { id: item.id, expectedRevision: 0, clientRequestId: 'forged', text: 'Approved' },
        {
          ...context,
          caller: { kind: 'local-cli' }
        }
      )
    ).rejects.toThrow('only from the Orca app')
    await expect(ack.handler({ id: item.id, from: 'another-agent' }, context)).rejects.toThrow(
      'another agent'
    )
  })
})
