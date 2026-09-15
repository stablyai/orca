import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  DISPATCH_REJECTED_WRITE_FAILED,
  dispatchRejectionReasonIsInternal,
  dispatchRejectionWasTransportWriteFailure
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const HUGE = 'x'.repeat(4 * DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes)

let root: string

let clock = 1_000

const journals = createTrackedJournalOpener()

async function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

async function settle(reason: string): Promise<string | null> {
  const journal = await open()
  await journal.appendSubmission({
    clientMessageId: 'msg-1',
    payloadFingerprint: 'e'.repeat(64),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    fence: 1
  })
  await journal.resolveDispatch({ clientMessageId: 'msg-1', state: 'rejected', reason, fence: 1 })

  return journal.snapshot().submissions[0]?.reason ?? null
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-dispatch-reason-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('dispatch reason bounding', () => {
  it('bounds an oversized provider error before it reaches the row', async () => {
    const stored = await settle(HUGE)
    expect(stored).not.toBeNull()
    expect(stored?.length).toBeLessThan(HUGE.length)
  })

  it('marks the clipped reason rather than truncating it silently', async () => {
    const stored = await settle(HUGE)
    expect(stored).toContain('[Orca: output truncated')
  })

  it('leaves a reason that already fits exactly as written', async () => {
    const stored = await settle(`${DISPATCH_REJECTED_WRITE_FAILED}: broken pipe`)
    expect(stored).toBe(`${DISPATCH_REJECTED_WRITE_FAILED}: broken pipe`)
  })

  // Head-first, not hash-replacing: the classifier prefix-matches, so a bound that kept
  // the tail would render raw provider text to the user as an ordinary rejection notice.
  it('keeps a clipped transport failure classifiable', async () => {
    const stored = await settle(`${DISPATCH_REJECTED_WRITE_FAILED}: ${HUGE}`)
    expect(stored).not.toBe(`${DISPATCH_REJECTED_WRITE_FAILED}: ${HUGE}`)
    expect(dispatchRejectionWasTransportWriteFailure(stored)).toBe(true)
    expect(dispatchRejectionReasonIsInternal(stored)).toBe(true)
  })
})
