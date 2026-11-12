import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_Y,
  createSessionCallerHarness,
  orchestrationRequest,
  idOf,
  resultOf,
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
