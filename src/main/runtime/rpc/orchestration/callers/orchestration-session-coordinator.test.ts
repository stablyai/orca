import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import {
  ADDRESS_Y,
  createSessionCallerHarness,
  orchestrationRequest,
  idOf,
  isRecord,
  resultOf,
  sessionRecord,
  SESSION_X,
  SESSION_Y,
  type SessionCallerHarness
} from './session.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

describe('a structured worker that names itself by session id', () => {
  let h: SessionCallerHarness
  const workerSession = SESSION_Y
  const handle = mintStructuredWorkerHandle()
  const paneKey = mintStructuredWorkerPaneKey(workerSession)

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    structuredWorkerIdentities.register({
      handle,
      sessionId: workerSession,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('sends mail at either of its spellings to its Dispatch once assigned in a Run it coordinated before', async () => {
    const { run } = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o' },
          { sessionId: workerSession }
        )
      )
    )
    const runId = idOf(run)
    // A chat takes the Run over; the worker's addresses stay remembered as a former coordinator's.
    resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.runUse', { id: runId }, { sessionId: SESSION_X })
      )
    )
    expect(h.db.getRunMailboxOwnerIdsForHandle(ADDRESS_Y)).toEqual([runId])
    const dispatch = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId, spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      creator: { kind: 'session', orcaSessionId: SESSION_X },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    // Both spellings name one party, so both land in the one mailbox it reads, not the Run's.
    for (const to of [ADDRESS_Y, handle]) {
      const { message } = resultOf(
        await h.dispatch(
          orchestrationRequest('orchestration.send', { to, subject: to }, { sessionId: SESSION_X })
        )
      )
      expect(message).toMatchObject({ to_handle: `dispatch:${dispatch.id}` })
    }
    const read = resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { peek: true }, { sessionId: workerSession })
      )
    )
    expect(read).toMatchObject({
      count: 2,
      messages: expect.arrayContaining([
        expect.objectContaining({ subject: handle }),
        expect.objectContaining({ subject: ADDRESS_Y })
      ])
    })
  })
})

const SENDER = testOrcaSessionId('8c4e2a19-6b5d-4f30-9a71-1e3c5d7b9f02')

describe('mail addressed to a chat that no longer coordinates a Run', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    h.records.set(SENDER, sessionRecord(SENDER))
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  async function send(subject: string): Promise<Record<string, unknown>> {
    return resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.send',
          { to: ADDRESS_Y, subject, body: subject },
          { sessionId: SENDER }
        )
      )
    )
  }

  async function subjects(sessionId: string): Promise<string[]> {
    const read = resultOf(
      await h.dispatch(orchestrationRequest('orchestration.check', { peek: true }, { sessionId }))
    )
    return Array.isArray(read.messages)
      ? read.messages.flatMap((message) =>
          isRecord(message) && typeof message.subject === 'string' ? [message.subject] : []
        )
      : []
  }

  const runCreate = async (sessionId: string, objective: string) =>
    idOf(
      resultOf(
        await h.dispatch(
          orchestrationRequest('orchestration.runCreate', { objective }, { sessionId })
        )
      ).run
    )
  const runUse = (sessionId: string, id: string) =>
    h.dispatch(orchestrationRequest('orchestration.runUse', { id }, { sessionId })).then(resultOf)

  it('reaches that chat after another session takes the Run, and still does after the taker binds a different Run', async () => {
    const runId = await runCreate(SESSION_Y, 'R')

    // The session that coordinates the Run reads its Run mailbox, so mail to it lands there.
    expect(await send('while coordinating')).toMatchObject({
      message: { to_handle: `run:${runId}` }
    })
    expect(await subjects(SESSION_Y)).toEqual(['while coordinating'])

    await runUse(SESSION_X, runId)

    expect(await send('after takeover')).toMatchObject({ message: { to_handle: ADDRESS_Y } })
    expect(await subjects(SESSION_Y)).toContain('after takeover')
    expect(await subjects(SESSION_X)).not.toContain('after takeover')

    const otherId = await runCreate(SENDER, 'S')
    await runUse(SESSION_X, otherId)

    expect(await send('after the taker rebound')).toMatchObject({
      message: { to_handle: ADDRESS_Y }
    })
    expect(await subjects(SESSION_Y)).toEqual(
      expect.arrayContaining(['after takeover', 'after the taker rebound'])
    )
    expect(await subjects(SESSION_X)).not.toContain('after takeover')
    expect(await subjects(SESSION_X)).not.toContain('after the taker rebound')
  })

  async function sendFrom(sessionId: string, subject: string): Promise<Record<string, unknown>> {
    return resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.send',
          { to: ADDRESS_Y, subject, body: subject },
          { sessionId }
        )
      )
    )
  }

  it('keeps mail sent from the coordinating chat on the unbound recipient across bind, checks, foreign routing, and takeover', async () => {
    const runId = await runCreate(SESSION_X, 'R')
    // A pre-upgrade database still names Y on this Run. The send must not follow that alias.
    h.db.db
      .prepare(
        `INSERT INTO run_coordinator_handles (run_id, terminal_handle, first_bound_at)
         VALUES (?, ?, datetime('now', '-1 day'))`
      )
      .run(runId, ADDRESS_Y)

    const sent = await sendFrom(SESSION_X, 'while X coordinates')
    const messageId =
      isRecord(sent.message) && typeof sent.message.id === 'string' ? sent.message.id : ''
    expect(sent).toMatchObject({ message: { to_handle: ADDRESS_Y, run_id: runId } })
    expect(await subjects(SESSION_Y)).toContain('while X coordinates')
    expect(await subjects(SESSION_X)).not.toContain('while X coordinates')

    // Bind in the same second without backdating created_at: sequence watermarking keeps the mail direct.
    await runUse(SESSION_Y, runId)
    expect(h.db.getMessageById(messageId)?.to_handle).toBe(ADDRESS_Y)
    // Neither peeking the Run nor detached foreign routing may sweep pre-binding direct mail into run:<id>.
    expect(await subjects(SESSION_Y)).not.toContain('while X coordinates')
    expect(h.db.routeForeignDirectMessagesToOwnedMailboxes(ADDRESS_Y).routedCount).toBe(0)
    expect(h.db.getMessageById(messageId)?.to_handle).toBe(ADDRESS_Y)

    // Taking the Run back leaves the unread pre-binding mail on Y, never on run:<id> or X.
    await runUse(SESSION_X, runId)
    expect(h.db.getMessageById(messageId)?.to_handle).toBe(ADDRESS_Y)
    expect(await subjects(SESSION_Y)).toContain('while X coordinates')
    expect(await subjects(SESSION_X)).not.toContain('while X coordinates')

    // When Y coordinates R again, its consuming check still receives its own pre-binding mail directly.
    await runUse(SESSION_Y, runId)
    const consumed = resultOf(
      await h.dispatch(orchestrationRequest('orchestration.check', {}, { sessionId: SESSION_Y }))
    )
    expect(consumed).toMatchObject({
      count: 1,
      messages: [expect.objectContaining({ id: messageId, subject: 'while X coordinates' })]
    })
    expect(h.db.getMessageById(messageId)?.to_handle).toBe(ADDRESS_Y)
  })

  it('keeps the taker bound to both Runs when the second one is created, and still delivers to the chat that lost the first', async () => {
    const runId = await runCreate(SESSION_Y, 'R')
    await runUse(SESSION_X, runId)
    const secondId = await runCreate(SESSION_X, 'R2')
    expect(
      h.db
        .runsBoundToCoordinator({ terminalHandle: null, paneKey: null, orcaSessionId: SESSION_X })
        .map((run) => run.id)
    ).toEqual([secondId, runId])

    expect(await sendFrom(SESSION_X, 'after the second Run')).toMatchObject({
      message: { to_handle: ADDRESS_Y, run_id: secondId }
    })
    expect(await subjects(SESSION_Y)).toContain('after the second Run')
    expect(await subjects(SESSION_X)).not.toContain('after the second Run')
    expect(h.db.getRunMailboxOwnerIdsForHandle(ADDRESS_Y)).toEqual([])
  })
})
