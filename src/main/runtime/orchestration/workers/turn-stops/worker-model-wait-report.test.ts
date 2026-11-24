import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { ChatWorkerModelWait, type ChatModelWaitJournal } from './chat-worker-model-wait'
import { modelWaitLastSeenLine } from './worker-model-wait-report'

const SESSION = testOrcaSessionId('5d2b8c41-7e6a-4f13-9b0d-2c4e6a8f1b37')
const MINUTE = 60_000
// Synthetic only.
const CAPABILITY = `dcap_${'a1B2'.repeat(8)}`
const KEY = `sk-ant-api03-${'x9Y8'.repeat(16)}`
// The notice's line limit, written out so the test does not borrow the code under test.
const LAST_SEEN_MAX_CHARS = 300

/** The body's retry-words field, cut at its label and at the sentence the notice ends with. */
function lastSeenField(body: string): string | undefined {
  return /Last seen: (.*?) It is still /u.exec(body)?.[1]
}

/** Both redaction markers and the kept sentinel; no raw credential, nothing past the cap. */
function expectOnlySanitized(texts: readonly string[], inside: string, past: string): void {
  for (const text of texts) {
    expect(text).toContain('[redacted:anthropic-key]')
    expect(text).toContain('[dispatch capability redacted]')
    expect(text).toContain(inside)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(CAPABILITY)
    expect(text).not.toContain(past)
    expect(text).not.toContain('overflow')
    expect(text).not.toContain('\\n')
    expect(text).not.toContain('\\t')
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the model-wait notice', () => {
  it('never copies a capability or credential from the worker screen into coordinator mail', () => {
    const line = modelWaitLastSeenLine(`  export ORCA_DISPATCH=${CAPABILITY}\n  KEY=${KEY}  `)
    expect(line).not.toContain(CAPABILITY)
    expect(line).not.toContain(KEY)
    expect(line).not.toContain('\n')
  })

  it('keeps a chat worker’s retry words, redacted, folded and then capped, in both notices', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'ship',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
    })
    const handle = formatOrcaSessionAddress(SESSION)
    const taskId = db.createTask({ spec: 'work', runId: run.id }).id
    const dispatchId = createRootDispatch(db, taskId, handle).id
    // Credentials and repeated whitespace early; one sentinel just inside the 300-character line
    // the notice keeps, one just past it, and a long tail after that.
    const head = 'Claude is retrying: overloaded'
    const raw = `${head}\n    token ${KEY}\t\t for   ${CAPABILITY}.`
    const redactedHead = `${head} token [redacted:anthropic-key] for [dispatch capability redacted].`
    const inside = 'SENTINEL_INSIDE_p3Nv'
    const past = 'SENTINEL_PAST_j8Tb'
    const tail = ` ${'overflow'.repeat(200)}`
    const kept = LAST_SEEN_MAX_CHARS - 1
    const fill = 'x'.repeat(kept - redactedHead.length - 1 - inside.length)
    const words = `${raw} ${fill}${inside} ${past}${tail}`
    const expected = `${redactedHead} ${fill}${inside}\u2026`
    expect(expected).toHaveLength(LAST_SEEN_MAX_CHARS)
    // Capping before redacting or folding would keep neither the same line nor the inside sentinel.
    expect(words.slice(0, kept)).not.toContain(inside)

    const feed: { onItems?: (ids: readonly string[] | null) => void } = {}
    const journal: ChatModelWaitJournal = {
      observe: (_sessionId, listener) => {
        feed.onItems = listener
        return () => {}
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watch reads only these fields.
      item: async (_sessionId, itemId) =>
        ({
          itemId,
          body: {
            kind: 'status',
            tone: 'warning',
            text: words,
            failure: { kind: 'providerRetrying' }
          }
        }) as unknown as AgentJournalRenderItem
    }
    const watch = new ChatWorkerModelWait(
      { getDb: () => db, notify: () => {}, isWaitingForMail: () => false },
      journal
    )
    watch.observe(SESSION, 'working')
    feed.onItems?.(['retry-1'])
    await vi.advanceTimersByTimeAsync(0)

    const mail = () => db.getUnreadRunMailbox(run.id, 100, ['escalation', 'status'])
    // The retry is told at once, as a notice.
    const [retrying] = mail()
    expect(mail()).toHaveLength(1)
    expect(retrying).toMatchObject({ from_handle: handle, type: 'status', priority: 'normal' })
    expect(JSON.parse(retrying.payload ?? '{}')).toEqual({
      taskId,
      dispatchId,
      handle,
      modelWait: 'retrying',
      lastSeen: expected
    })
    expect(lastSeenField(retrying.body)).toBe(expected)
    expectOnlySanitized([retrying.body, retrying.payload ?? ''], inside, past)

    // Ten quiet minutes later the wait itself goes up as an escalation, with the same retry line.
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    const later = mail()
    expect(later).toHaveLength(2)
    const waiting = later.find((message) => message.id !== retrying.id)
    if (!waiting) {
      throw new Error('no waiting notice')
    }
    expect(waiting).toMatchObject({ from_handle: handle, type: 'escalation', priority: 'high' })
    expect(JSON.parse(waiting.payload ?? '{}')).toEqual({
      taskId,
      dispatchId,
      handle,
      modelWait: 'waiting',
      lastSeen: expected
    })
    expect(lastSeenField(waiting.body)).toBe(expected)
    expect(waiting.body).toContain('10 min')
    expectOnlySanitized([waiting.body, waiting.payload ?? ''], inside, past)

    watch.dispose()
    db.close()
  })
})
