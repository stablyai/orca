import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { prepareCollaborationCheckpoint } from '../../collaboration/collaboration-checkpoint-store'
import { buildCollaborationTaskMailboxAddress } from '../../collaboration/collaboration-task-mailbox'
import { encodeCollaborationMessagePayload } from '../../collaboration/collaboration-message-payload'
import type { MessagePriority } from '../../orchestration/types'
import type { RpcContext } from '../core'
import { COLLABORATION_ACK_METHODS } from './collaboration-ack'

const WORKER_PANE_KEY = 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROCESS_INCARNATION = 'runtime_test:term_worker:1'

type AckReceipt = {
  messageIds: string[]
  duplicate: boolean
}

describe('orchestration.collaborationAck', () => {
  const method = COLLABORATION_ACK_METHODS[0]!

  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let taskId: string
  let dispatchId: string

  function insertCollaborationMessage(id: string, task = taskId): string {
    const row = db.insertMessage({
      id,
      from: 'producer',
      to: buildCollaborationTaskMailboxAddress(task),
      subject: 't',
      body: `body:${id}`,
      type: 'status',
      priority: 'normal' satisfies MessagePriority,
      payload: encodeCollaborationMessagePayload({
        version: 1,
        topic: 't',
        semanticType: 'checkpoint',
        producerTaskId: 'producer'
      })
    })
    return row.id
  }

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE_KEY : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? PROCESS_INCARNATION : null
    )
    runId = db.createRun({
      objective: 'collaboration ack',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }).id
    taskId = db.createTask({ spec: 'worker', runId }).id
    dispatchId = db.createDispatchContext(taskId, 'term_worker', WORKER_PANE_KEY).id
  }

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  async function call(
    params: Record<string, unknown>,
    ctx: Partial<RpcContext> = {}
  ): Promise<unknown> {
    const parsed = method.params!.parse(params)
    return method.handler(parsed, { runtime, ...ctx } as RpcContext)
  }

  function ackParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { from: 'term_worker', messageIds: ['m0'], ...overrides }
  }

  function deliverCheckpoint(): void {
    prepareCollaborationCheckpoint(db, taskId, {
      acceptedTypes: ['checkpoint'],
      minPriority: 'normal'
    })
  }

  it('marks unread ids consumed and returns duplicate false', async () => {
    setup()
    insertCollaborationMessage('m0')
    deliverCheckpoint()

    const result = (await call(ackParams())) as AckReceipt

    expect(result).toEqual({ messageIds: ['m0'], duplicate: false })
    expect(db.getMessageById('m0')?.read).toBe(1)
  })

  it('returns duplicate true when all ids were already acked', async () => {
    setup()
    insertCollaborationMessage('m0')
    deliverCheckpoint()
    await call(ackParams())

    const result = (await call(ackParams())) as AckReceipt

    expect(result).toEqual({ messageIds: ['m0'], duplicate: true })
    expect(db.getMessageById('m0')?.read).toBe(1)
  })

  it('acks multiple ids and echoes them back', async () => {
    setup()
    insertCollaborationMessage('m0')
    insertCollaborationMessage('m1')
    deliverCheckpoint()

    const result = (await call(ackParams({ messageIds: ['m0', 'm1'] }))) as AckReceipt

    expect(result).toEqual({ messageIds: ['m0', 'm1'], duplicate: false })
    expect(db.getMessageById('m0')?.read).toBe(1)
    expect(db.getMessageById('m1')?.read).toBe(1)
  })

  it('rejects a valid same-mailbox id that was never delivered by checkpoint', async () => {
    setup()
    insertCollaborationMessage('m0')

    await expect(call(ackParams())).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(db.getMessageById('m0')?.read).toBe(0)
    expect(db.getMessageById('m0')?.delivered_at).toBeNull()
  })

  it('rejects an id belonging to a different mailbox', async () => {
    setup()
    const otherTaskId = db.createTask({ spec: 'other', runId }).id
    insertCollaborationMessage('other', otherTaskId)

    await expect(call(ackParams({ messageIds: ['other'] }))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(db.getMessageById('other')?.read).toBe(0)
  })

  it('rejects a missing message id as invalid_argument', async () => {
    setup()

    await expect(call(ackParams({ messageIds: ['missing'] }))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('rejects a message without a valid collaboration payload as invalid_argument', async () => {
    setup()
    db.insertMessage({
      id: 'invalid-payload',
      from: 'producer',
      to: buildCollaborationTaskMailboxAddress(taskId),
      subject: 't',
      body: 'bad',
      type: 'status',
      priority: 'normal',
      payload: 'not-collaboration-json'
    })

    await expect(call(ackParams({ messageIds: ['invalid-payload'] }))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(db.getMessageById('invalid-payload')?.read).toBe(0)
  })

  it('rejects a mixed read/unread batch as invalid_argument', async () => {
    setup()
    insertCollaborationMessage('m0')
    insertCollaborationMessage('m1')
    deliverCheckpoint()
    await call(ackParams({ messageIds: ['m0'] }))

    await expect(call(ackParams({ messageIds: ['m0', 'm1'] }))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(db.getMessageById('m0')?.read).toBe(1)
    expect(db.getMessageById('m1')?.read).toBe(0)
  })

  it('rejects a wrong orchestration capability', async () => {
    setup()
    insertCollaborationMessage('m0')
    db.mintDispatchCapability({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })

    await expect(
      call(ackParams(), { orchestrationCapability: 'dcap_wrong' })
    ).rejects.toMatchObject({ code: 'dispatch_capability_invalid' })
    expect(db.getMessageById('m0')?.read).toBe(0)
  })

  it('rejects when there is no active dispatch', async () => {
    setup()
    insertCollaborationMessage('m0')

    await expect(call(ackParams({ from: 'term_idle' }))).rejects.toMatchObject({
      code: 'dispatch_inactive'
    })
    expect(db.getMessageById('m0')?.read).toBe(0)
  })

  it('ignores caller-supplied taskId and dispatchId', async () => {
    setup()
    const otherTaskId = db.createTask({ spec: 'other', runId }).id
    insertCollaborationMessage('m0')
    deliverCheckpoint()

    const result = (await call(
      ackParams({ taskId: otherTaskId, dispatchId: 'caller-fake-dispatch' })
    )) as AckReceipt

    expect(result).toEqual({ messageIds: ['m0'], duplicate: false })
    expect(db.getMessageById('m0')?.read).toBe(1)
  })

  it('rejects an empty messageIds array', async () => {
    setup()

    await expect(call(ackParams({ messageIds: [] }))).rejects.toThrow()
  })

  it('rejects an empty string messageId', async () => {
    setup()

    await expect(call(ackParams({ messageIds: [''] }))).rejects.toThrow()
  })

  it('rejects more than 100 messageIds', async () => {
    setup()

    await expect(
      call(ackParams({ messageIds: Array.from({ length: 101 }, (_, i) => `m${i}`) }))
    ).rejects.toThrow()
  })
})
