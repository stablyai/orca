/**
 * A structured worker is taught one address, `session:<id>`. The handle it was minted is only its
 * mailbox key, so every mailbox read an agent sees spells the worker the way its preamble does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { formatReadMessages } from './methods/orchestration/messaging/mailbox-message-receipt'
import {
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('a structured worker reads as session:<id> wherever an agent reads mail', () => {
  let h: SessionCallerHarness
  let workerHandle: string

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    workerHandle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle: workerHandle,
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey: mintStructuredWorkerPaneKey(SESSION_Y),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it("shows the coordinator its worker's session address in the rows and the banner", async () => {
    const created = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o' },
          { sessionId: SESSION_X }
        )
      )
    )
    const runId = idOf(created.run)
    h.db.insertMessage({
      from: workerHandle,
      to: `run:${runId}`,
      subject: 'progress',
      type: 'status',
      runId
    })

    const checked = resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { format: true }, { sessionId: SESSION_X })
      )
    )

    expect(checked.messages).toEqual([
      expect.objectContaining({ from_handle: `session:${SESSION_Y}` })
    ])
    expect(checked.formatted).toContain(`(session:${SESSION_Y})`)
    expect(JSON.stringify(checked)).not.toContain(workerHandle)
  })

  it('tells the worker to reply as its session address, which the host binds to the same mailbox', () => {
    const row = h.db.insertMessage({
      from: 'term_coord',
      to: workerHandle,
      subject: 'follow-up',
      type: 'status'
    })

    const formatted = formatReadMessages([row], h.db)

    expect(formatted).toContain(`--from session:${SESSION_Y} `)
    expect(formatted).not.toContain(workerHandle)
    // Stored under the mailbox key: only the reading is re-spelled.
    expect(h.db.getMessageById(row.id)?.to_handle).toBe(workerHandle)
  })
})
