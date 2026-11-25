import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTestAgentSessionDatabase } from '../../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { createQueuedMessageTestRig } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { storedProviderReceipt } from '../../../native-chat/agent-session-journal/journal-dispatch-written.test-fixture'
import { journalSqlWorkerPath } from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { deliverClaudeReplayFrame } from '../lifecycle/claude-structured-event-delivery'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import { expect, it, vi } from 'vitest'
import { resolveClaudeReplayTurn } from './claude-replay-turn-resolution'
import { recordClaudeDispatchReceipt } from './claude-command-lifecycle'
import { retireWaiter, waitForReplay } from '../dispatch/claude-structured-dispatch-waiters'
import type { ClaudeLateDispatchOutcome, ClaudeSession } from '../claude-structured-session-state'

const SESSION = '00000000-0000-4000-8000-00000000c1a0'
const SENT = 'ec94ea32-e87c-4cef-9ff1-be319d2e77a5'
const RESULT = '5bfd911d-c26b-4598-bc75-959a8a2fd86d'

const lifecycle = (state: string): Record<string, unknown> => ({
  type: 'command_lifecycle',
  command_uuid: SENT,
  state,
  session_id: SESSION
})

// Frames Claude Code 2.1.330 sent for a prompt stopped while its UserPromptSubmit hook ran, trimmed to what is read.
// The result precedes lifecycle `cancelled`; the reverse order would release the send in doubt instead.
const stopFrames: Record<string, unknown>[] = [
  lifecycle('queued'),
  lifecycle('started'),
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: '86166d82-2504-4a44-8f86-c94a7c967db4'
  },
  {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: SESSION,
    uuid: RESULT,
    terminal_reason: 'aborted_streaming',
    user_message_uuid: SENT,
    user_message_uuids: [SENT]
  },
  lifecycle('cancelled')
]

function stop() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the uuid-correlated path reads only these fields; translator is optional.
  const session = {
    providerSessionId: SESSION,
    dispatchSequence: 0,
    dispatchWaiters: [],
    retiredDispatchWaiters: []
  } as unknown as ClaudeSession
  const { promise } = waitForReplay(session, false, SENT, 'key', 'client-1', null)
  const settled: ClaudeLateDispatchOutcome[] = []
  for (const frame of stopFrames) {
    resolveClaudeReplayTurn(session, frame, (outcome) => settled.push(outcome))
  }
  return { settled, promise, session }
}

it('settles a prompt Claude dropped on Stop as unrun, never under the result frame uuid', async () => {
  const { settled, promise, session } = stop()
  expect(settled).toHaveLength(1)
  expect(settled[0]).toMatchObject({ clientMessageId: 'client-1', state: 'rejected', unrun: true })
  expect(JSON.stringify(settled)).not.toContain(RESULT)
  expect(await promise).toBeNull()
  expect(session.dispatchWaiters).toHaveLength(0)
})

it('records only the first matched receipt from a live dispatch', () => {
  const { session } = stop()
  session.fence = 2
  const handover = { epoch: 'epoch', sequence: 5 }
  const arm = (uuid: string, clientMessageId: string) =>
    waitForReplay(session, false, uuid, 'key', clientMessageId, null, session.fence, handover)
  const receipts: unknown[] = []
  const frame = (message: Record<string, unknown>, at: number) =>
    resolveClaudeReplayTurn(session, message, undefined, (waiter) =>
      recordClaudeDispatchReceipt(session, waiter, at, (receipt) => receipts.push(receipt))
    )

  arm(SENT, 'opener')
  frame({ ...lifecycle('queued'), command_uuid: 'another-send' }, 100)
  frame(lifecycle('queued'), 200)
  frame(lifecycle('queued'), 210)
  frame(lifecycle('started'), 250)
  const fallback = 'p2'
  const fallbackWaiter = arm(fallback, 'follow-up')
  fallbackWaiter.waiter.steers = true
  frame({ ...lifecycle('started'), command_uuid: fallback }, 300)
  const retired = arm('p3', 'retired')
  retireWaiter(session, retired.waiter)
  frame({ ...lifecycle('queued'), command_uuid: 'p3' }, 400)
  arm('p4', 'stale')
  session.fence++
  frame({ ...lifecycle('started'), command_uuid: 'p4' }, 500)

  expect(receipts).toEqual([
    { clientMessageId: 'opener', fence: 2, handoverCursor: handover, observedAt: 200 },
    { clientMessageId: 'follow-up', fence: 2, handoverCursor: handover, observedAt: 300 }
  ])
})

type CommitFault = 'before' | 'ended-before' | 'after' | 'rollback' | 'connection'

async function faultingWriter(root: string): Promise<string> {
  const path = join(root, 'faulting-writer.cjs')
  await writeFile(
    path,
    `
    const { DatabaseSync } = require('node:sqlite')
    const fs = require('node:fs')
    const faultPath = ${JSON.stringify(join(root, 'commit-fault'))}
    const exec = DatabaseSync.prototype.exec
    let failRollback = false
    DatabaseSync.prototype.exec = function (sql) {
      const fault = sql === 'COMMIT' && fs.existsSync(faultPath)
        ? fs.readFileSync(faultPath, 'utf8') : null
      if (fault) {
        fs.unlinkSync(faultPath)
        if (fault === 'after') exec.call(this, 'COMMIT')
        if (fault === 'ended-before') exec.call(this, 'ROLLBACK')
        if (fault === 'connection') this.close()
        failRollback = fault === 'rollback'
        const error = new Error('injected COMMIT I/O failure')
        if (fault === 'before') throw error
        throw Object.assign(error, {
          code: 'ERR_SQLITE_ERROR', errcode: 10
        })
      }
      if (failRollback && sql === 'ROLLBACK') {
        failRollback = false
        throw new Error('injected ROLLBACK failure')
      }
      return exec.call(this, sql)
    }
    require(${JSON.stringify(journalSqlWorkerPath())})
    `
  )
  return path
}

it.each<CommitFault | 'statement'>([
  'statement',
  'before',
  'ended-before',
  'after',
  'rollback',
  'connection'
])('isolates a receipt write failure only with a usable SQLite writer (%s)', async (fault) => {
  const warn = vi.fn()
  let now = HOST_TEST_NOW
  const rig = await createQueuedMessageTestRig({
    agent: 'claude',
    writerBundle: faultingWriter,
    now: () => now,
    hostDeps: { logger: { warn, error: () => {} } }
  })
  try {
    const id = await rig.workingSend()
    const dispatch = rig.dispatch.mock.lastCall![0]
    const handoverCursor = dispatch.handoverCursor!()!
    const sink = rig.providerEvents()
    const sessions = rig.host.collaboratorsForTests().sessions
    const alive = sessions.get(HOST_TEST_SESSION)?.child
    const journal = (await rig.host.conversation(HOST_TEST_SESSION)).journal
    const ops: Promise<void>[] = []
    const translator = createClaudeJournalTranslator({ sink })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only replay state and the real translator are needed for these frames.
    const session = {
      providerSessionId: SESSION,
      fence: dispatch.fence,
      dispatchSequence: 0,
      dispatchWaiters: [],
      retiredDispatchWaiters: [],
      translator
    } as unknown as ClaudeSession
    waitForReplay(session, false, SENT, 'key', id, now, dispatch.fence, handoverCursor)
    const frame = (message: Record<string, unknown>, observedAt: number) =>
      deliverClaudeReplayFrame({
        session,
        message,
        sessionId: HOST_TEST_SESSION,
        now: () => observedAt,
        deliver: (run) => run(),
        isCurrent: () => true,
        emit: translator.handle,
        onReceipt: sink.recordProviderReceipt,
        onSettledLate: (outcome) =>
          void ops.push(rig.host.settleLateDispatch({ sessionId: HOST_TEST_SESSION, ...outcome }))
      })
    expect((await rig.submission(id))?.dispatchState).toBe('pending')
    expect(alive?.phase).toBe('ready')
    const receipt = () => storedProviderReceipt(rig.root, HOST_TEST_SESSION, id)
    const sql = (statement: string) =>
      withTestAgentSessionDatabase(rig.root, (db) => db.exec(statement))
    const inject = (mode: CommitFault) => writeFile(join(rig.root, 'commit-fault'), mode)
    await (fault === 'statement'
      ? sql(`CREATE TRIGGER fail_receipt BEFORE INSERT ON journal_dispatch_written
          BEGIN SELECT RAISE(ABORT, 'injected statement failure'); END`)
      : inject(fault))

    const priorActivity = sessions.lastActivityAt(HOST_TEST_SESSION)
    now = HOST_TEST_NOW + 500
    frame(lifecycle('queued'), now)
    await sink.written!()
    if (fault === 'rollback' || fault === 'connection') {
      await expect(
        journal.appendItem(
          { provider: 'orca', clientMessageId: 'must-fail' },
          { kind: 'status', text: 'Uncertain receipt transaction' },
          { fence: dispatch.fence, turnScope: { kind: 'thread' } }
        )
      ).rejects.toThrow('injected COMMIT I/O failure')
      return
    }
    expect(sessions.get(HOST_TEST_SESSION)?.child?.phase).toBe('ready')
    expect(await receipt()).toBe(fault === 'after' ? HOST_TEST_NOW + 500 : undefined)
    expect(sessions.lastActivityAt(HOST_TEST_SESSION)).toBe(
      fault === 'after' ? HOST_TEST_NOW + 500 : priorActivity
    )
    if (fault === 'after') {
      now = HOST_TEST_NOW + 600
      sink.recordProviderReceipt?.({
        clientMessageId: id,
        handoverCursor,
        fence: dispatch.fence,
        observedAt: now
      })
      expect(await sink.written!()).toEqual({ ok: true })
      expect(await receipt()).toBe(HOST_TEST_NOW + 500)
      expect(sessions.lastActivityAt(HOST_TEST_SESSION)).toBe(HOST_TEST_NOW + 500)
    } else {
      expect(warn).toHaveBeenCalledWith(
        'writing a provider receipt failed',
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('injected') })
        })
      )
    }
    if (fault === 'statement') {
      await sql('DROP TRIGGER fail_receipt')
    }

    frame(lifecycle('started'), 2_000)
    expect(await sink.written!()).toEqual({ ok: true })
    expect(await journal.reads.runningTurn()).toBeNull()
    frame(
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        parent_tool_use_id: null,
        uuid: RESULT,
        user_message_uuid: SENT,
        session_id: SESSION
      },
      2_100
    )
    const output = {
      type: 'assistant',
      session_id: SESSION,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] },
      parent_tool_use_id: null,
      uuid: '619f98bd-92b5-4a2e-bcdf-27ce4346562e'
    }
    frame(output, 2_500)
    await Promise.all(ops)
    expect(await sink.written!()).toEqual({ ok: true })
    expect((await rig.submission(id))?.dispatchState).toBe('accepted')
    expect(await journal.reads.runningTurn()).toMatchObject({
      turnId: RESULT,
      item: { body: { startedAt: 2_100 } }
    })
    const assistantRows = () =>
      withTestAgentSessionDatabase(
        rig.root,
        (db) =>
          db
            .prepare(
              "SELECT count(*) AS count FROM journal_items WHERE session_id=? AND message_role='assistant'"
            )
            .get(HOST_TEST_SESSION)?.count
      )
    expect(await assistantRows()).toBe(1)
    expect(sessions.get(HOST_TEST_SESSION)?.child).toBe(alive)
    expect(rig.closeSession).not.toHaveBeenCalled()

    if (fault === 'after') {
      await inject('ended-before')
      frame({ ...output, uuid: 'next-content' }, 3_000)
      expect(await sink.written!()).toMatchObject({ ok: false })
      await eventually(() => expect(rig.closeSession).toHaveBeenCalledTimes(1))
      expect(await assistantRows()).toBe(1)
      await expect(
        journal.appendItem(
          { provider: 'orca', clientMessageId: 'after-content-fault' },
          { kind: 'status', text: 'The shared writer must remain faulted' },
          { fence: dispatch.fence, turnScope: { kind: 'thread' } }
        )
      ).rejects.toThrow('injected COMMIT I/O failure')
    }
  } finally {
    await rig.dispose().catch((error: unknown) => {
      if (fault !== 'rollback' && fault !== 'connection' && fault !== 'after') {
        throw error
      }
      expect(error).toMatchObject({
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('injected COMMIT I/O failure')
          })
        ])
      })
    })
  }
})
