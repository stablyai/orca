import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalConnectorClaim } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { readJournalConnectorReplies } from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies-read'
import {
  admit,
  asked,
  installReplyMatrix,
  NOW,
  start,
  stampOf
} from './connector-reply-matrix.test-fixture'

// Item 964, on the reply matrix's real journal: a fill too old to post closes its request quietly.

installReplyMatrix()

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const continueBody = (claim: AgentJournalConnectorClaim): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Continue.' }],
  connectorClaim: claim
})

type Process = ReturnType<typeof start>

/** A process filling at this time on the fake clock, started by a restart just before it; its
 *  requests were admitted at NOW, before that restart. */
function startAt(at: number, options: Parameters<typeof start>[0] = {}): Process {
  vi.setSystemTime(at)
  return start({ processStartedAt: at - MINUTE, ...options })
}

/** Why each row closed quietly, if it did. */
const reasons = (p: Process) =>
  Object.fromEntries(
    readJournalConnectorReplies(p.db).map((row) => [
      row.deliveryId,
      row.fill?.expiredReason ?? null
    ])
  )

/** m1 asked d1; the turn it opened was cut, and a launch continuation c1 claimed the request. */
async function cutAndClaimed(p: Process) {
  admit(p.db, 'm1', asked('d1'))
  p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
  const claim = await p.recovery.claimFor('chat-1', { turnId: 'provider-item:t1', kind: 'restart' })
  admit(p.db, 'c1', continueBody(claim!))
  return claim!
}

/** The continuation's live turn end, as the turn-end watch fills it. */
const continuationEnded = (p: Process, claim: AgentJournalConnectorClaim, prose: string) =>
  p.fillTurn({
    sessionId: 'chat-1',
    turnItemId: 'item:t2',
    stamps: claim.origin,
    openerItemId: agentJournalSubmissionKey('c1'),
    outcome: 'success',
    prose,
    bot: false,
    links: []
  })

describe('a fill too old to post', () => {
  it('closes quietly when recovery finds an answer whose turn ended over an hour ago', async () => {
    const p = startAt(NOW + 2 * HOUR, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed', 'Done yesterday.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
    expect(reasons(p).d1).toMatch(/^stale_answer: answered ended at /)
  })

  it('still posts an answer recovery finds within the hour', async () => {
    const p = startAt(NOW + 10 * MINUTE, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed', 'Done just now.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'Done just now.', head: 'd1' }
    })
    expect(reasons(p).d1).toBeNull()
  })

  it('closes quietly when a restart continuation answers a request admitted over a day ago', async () => {
    const p = startAt(NOW + 25 * HOUR)
    const claim = await cutAndClaimed(p)
    await continuationEnded(p, claim, 'Finished after the restart.')
    expect(p.outcomes()).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
    expect(reasons(p).d1).toMatch(/^old_request: answered for a request admitted at /)
  })

  it('posts a restart continuation’s answer to a request with no admission date of its own', async () => {
    const p = startAt(NOW + 25 * HOUR)
    const claim = await cutAndClaimed(p)
    // A row an older build wrote carries no date: a missing date never loses an answer.
    p.db.exec('UPDATE journal_connector_replies SET admitted_at=NULL')
    await continuationEnded(p, claim, 'Finished after the restart.')
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'Finished after the restart.', head: 'd1' }
    })
  })

  it('closes a day-old cut quietly instead of telling the thread it was interrupted', async () => {
    const p = startAt(NOW + 25 * HOUR, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
    expect(reasons(p).d1).toMatch(/^old_request: interrupted /)
  })

  it('still tells a usage-limit pause’s request how it ended, however old', async () => {
    let disposition = 'pending'
    const p = startAt(NOW + 3 * 24 * HOUR, {
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => disposition
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    await p.limited('item:t1', 'm1', [stampOf('d1')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    // The thread was told the work resumes later: its end is told whenever it comes.
    disposition = 'ended'
    p.recovery.statusChanged('chat-1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'failed', head: 'd1', category: 'usage_limit' }
    })
  })
})
