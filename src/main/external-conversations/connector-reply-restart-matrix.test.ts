import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalConnectorClaim } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'

import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import { conversationReplyFill } from './external-conversation-reply-fill'

import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import { ConnectorReplyOutbox, replyEventsOf } from '../connector-cloud/connector-reply-outbox'
import type { ConnectorReplyBody } from '../connector-cloud/connector-replies'

import {
  NOW,
  LIMIT,
  installReplyMatrix,
  admit,
  asked,
  start,
  stampOf,
  submissionOf
} from './connector-reply-matrix.test-fixture'

// Phase 1 restart matrix, desktop side: a real journal file reopened on every "restart", the real
// admission writer, recovery and fill, a fake clock. Each case asserts the rows' durable outcome.

installReplyMatrix()

describe('a restart cut, continued at launch', () => {
  it('answers the cut request and its carried send under the original head with the continuation’s words', async () => {
    const launch = Promise.withResolvers<void>()
    const before = start()
    admit(before.db, 'm1', asked('d1', ['d2']))
    before.db.close()
    // Restart: the turn m1 opened was cut; this launch continues it.
    const p = start({ continuationsSettled: launch.promise })
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null }, d2: { outcome: null } })
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    expect(claim?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1', 'd2'])
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'completed', 'All fixed.')])
    launch.resolve()
    await p.publish()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'All fixed.', head: 'd1' },
      d2: { outcome: 'answered', prose: 'All fixed.', head: 'd1' }
    })
  })

  it('claims a request whose send was cut before its turn was seen (a send’s cut)', async () => {
    const launch = Promise.withResolvers<void>()
    const p = start({ continuationsSettled: launch.promise })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1')], [submissionOf('m1', { dispatchState: 'unknown' })])
    const claim = await p.recovery.claimFor('chat-1', { turnId: 'm1', kind: 'restart' })
    expect(claim?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1'])
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    p.show([
      ...p.items(),
      p.message('c1'),
      ...p.turn('item:t2', 'c1', 'completed', 'Done after the restart.')
    ])
    launch.resolve()
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'Done after the restart.', head: 'd1' }
    })
  })

  it('leaves a cut owed until this launch settled, then closes what nothing continued as interrupted', async () => {
    const launch = Promise.withResolvers<void>()
    const p = start({ continuationsSettled: launch.promise })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    await p.recovery.boot()
    // A crash cut this launch adopts later reads "no offer" now: nothing closes before it settles.
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    launch.resolve()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(p.outcomes()).toEqual({ d1: { outcome: 'interrupted', head: 'd1' } })
  })

  it('never lets the cut turn’s own late end fill a row its continuation claimed', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    const fill = conversationReplyFill(
      () => p.journal,
      () => {}
    )
    await fill({
      sessionId: 'chat-1',
      turnItemId: 'item:t1',
      stamps: claim!.origin,
      openerItemId: agentJournalSubmissionKey('m1'),
      outcome: 'success',
      prose: 'Stale words.',
      bot: false,
      links: []
    })
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
  })

  it('tells an unconfirmed end when the claiming continuation never became a turn', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    p.show(
      [...p.items(), p.message('c1')],
      [submissionOf('c1', { dispatchState: 'unknown', recovered: true })]
    )
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'interrupted', head: 'd1', category: 'unconfirmed' }
    })
  })

  it('answers through a second continuation after the first one’s turn was cut too', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const first = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: first!
    })
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'interrupted')])
    const second = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t2',
      kind: 'restart'
    })
    expect(second?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1'])
    admit(p.db, 'c2', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: second!
    })
    p.show([...p.items(), p.message('c2'), ...p.turn('item:t3', 'c2', 'completed', 'Finally.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Finally.', head: 'd1' } })
  })

  it('answers through a second continuation when a restart cut the first before its turn opened', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const first = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: first!
    })
    // The next launch's marker names the continuation's own send: no turn took it.
    p.show([...p.items(), p.message('c1')], [submissionOf('c1', { dispatchState: 'pending' })])
    const second = await p.recovery.claimFor('chat-1', { turnId: 'c1', kind: 'restart' })
    expect(second?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1'])
    admit(p.db, 'c2', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: second!
    })
    p.show([...p.items(), p.message('c2'), ...p.turn('item:t2', 'c2', 'completed', 'Picked up.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Picked up.', head: 'd1' } })
  })
})

describe('a usage-limit pause', () => {
  const continueBody = (claim: AgentJournalConnectorClaim): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue.' }],
    connectorClaim: claim
  })

  it('pauses the request while its continue is pending, and the continue answers it', async () => {
    const p = start({
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'pending'
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    const ended = await p.limited('item:t1', 'm1', [stampOf('d1')])
    expect(ended.paused).toBe(true)
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    const claim = await p.recovery.claimFor('chat-1', { turnId: 'item:t1', kind: 'usage_limit' })
    expect(claim?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1'])
    admit(p.db, 'c1', continueBody(claim!))
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'completed', 'Back on it.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Back on it.', head: 'd1' } })
  })

  it('fails the request with the limit it hit once no continue will come', async () => {
    let disposition = 'pending'
    const p = start({
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => disposition
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    await p.limited('item:t1', 'm1', [stampOf('d1')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    // The person cancelled the automatic continue: no journal change, only the chat's status.
    disposition = 'ended'
    p.recovery.statusChanged('chat-1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'failed', head: 'd1', category: 'usage_limit' }
    })
  })

  it('fails the request when the continue’s send went unconfirmed and it never claimed (U4)', async () => {
    const p = start({
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'ambiguous'
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    await p.journal.cut({
      keys: [{ account: 'account-a', deliveryId: 'd1' }],
      cut: { turnId: 'item:t1', kind: 'usage_limit' },
      failure: LIMIT
    })
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'failed', head: 'd1', category: 'usage_limit' }
    })
  })

  it('cuts a restart continuation’s claim again when its own turn hits the limit (A12)', async () => {
    const p = start({
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'pending'
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const restart = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', continueBody(restart!))
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'failed')])
    await p.limited('item:t2', 'c1', restart!.origin)
    const resume = await p.recovery.claimFor('chat-1', { turnId: 'item:t2', kind: 'usage_limit' })
    expect(resume).toMatchObject({ cutKind: 'usage_limit', origin: [{ deliveryId: 'd1' }] })
    admit(p.db, 'c2', continueBody(resume!))
    p.show([...p.items(), p.message('c2'), ...p.turn('item:t3', 'c2', 'completed', 'Resumed.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Resumed.', head: 'd1' } })
  })
})

describe('a bot’s words before its quiet marker across a pause', () => {
  const DM = { source: 'slack', externalId: 'T1:D0OWNER:D0OWNER:U9' }
  const dmAsked: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'fix it' }],
    origin: 'connector',
    asker: {
      source: 'slack',
      userId: 'U0MEMBER',
      role: 'member',
      place: { kind: 'direct_message', id: 'D0OWNER' }
    },
    connectorDelivery: { account: 'account-a', conversation: DM, deliveryId: 'd1' }
  }
  // A member's DM asks, the usage limit pauses it, and the automatic continue answers with `prose`.
  const pausedThenContinued = async (prose: string) => {
    const p = start({
      bot: true,
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'pending'
    })
    admit(p.db, 'm1', dmAsked)
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    const stamp = { account: 'account-a', conversation: DM, deliveryId: 'd1' }
    expect((await p.limited('item:t1', 'm1', [stamp])).paused).toBe(true)
    const claim = await p.recovery.claimFor('chat-1', { turnId: 'item:t1', kind: 'usage_limit' })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'completed', prose)])
    await p.recovery.boot()
    return p.outcomes()
  }

  it('posts the words the continue wrote before its marker, once', async () => {
    expect(await pausedThenContinued('Both fixes landed.\n\nNO_REPLY')).toEqual({
      d1: { outcome: 'answered', prose: 'Both fixes landed.', head: 'd1' }
    })
  })

  it('keeps a continue that wrote only the marker quiet', async () => {
    expect(await pausedThenContinued('NO_REPLY')).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
  })
})

describe('an upgrade restart between a bot’s quiet reply and its fill', () => {
  // The thread asks; the turn ends with words and the marker while the app restarts, and the next
  // launch's recovery fills the row. `olderBuild`: the row was admitted before the trailing rule.
  const recoveredAfterUpgrade = async (olderBuild: boolean) => {
    const before = start({ bot: true })
    admit(before.db, 'm1', asked('d1'))
    if (olderBuild) {
      before.db.prepare('UPDATE journal_connector_replies SET quiet_rule=NULL').run()
    }
    before.db.close()
    const p = start({ bot: true, continuationsSettled: Promise.resolve() })
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed', 'Checked it.\n\nNO_REPLY')])
    await p.recovery.boot()
    return p.outcomes()
  }

  it('keeps a reply the older build admitted quiet, as its turn began', async () => {
    expect(await recoveredAfterUpgrade(true)).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
  })

  it('posts the words before the marker for a reply this build admitted', async () => {
    expect(await recoveredAfterUpgrade(false)).toEqual({
      d1: { outcome: 'answered', prose: 'Checked it.', head: 'd1' }
    })
  })
})

describe('no positional "answered together" across a restart', () => {
  const unrelated: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'unrelated' }]
  }

  it('tells an unconfirmed end for a send an earlier process accepted that no turn proves it took', async () => {
    vi.setSystemTime(NOW)
    const before = start()
    admit(before.db, 'm1', asked('d1'))
    before.db.close()
    vi.setSystemTime(NOW + 60_000)
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'other', unrelated)
    p.show(
      [p.message('m1'), ...p.turn('item:t1', 'other', 'completed', 'Unrelated answer.')],
      [submissionOf('m1', { submittedAt: NOW })]
    )
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'interrupted', head: 'd1', category: 'unconfirmed' }
    })
  })

  it('answers together a follow-up sent into a running turn once a later turn ends', async () => {
    vi.setSystemTime(NOW - 60_000)
    const p = start()
    admit(p.db, 'm0', asked('d0'))
    admit(p.db, 'm1', asked('d1'))
    p.recovery.admitted('chat-1')
    const first = [p.message('m0'), ...p.turn('item:t1', 'm0', 'completed', 'First answer.')]
    const sends = [
      submissionOf('m0', { submittedAt: NOW }),
      submissionOf('m1', { submittedAt: NOW })
    ]
    p.show([...first, p.message('m1')], sends)
    p.recovery.turnEnded('chat-1')
    await p.publish()
    // Orchestration mail wakes a later turn after the follow-up, and it ends.
    admit(p.db, 'mail', unrelated)
    p.show(
      [...p.items(), p.message('mail'), ...p.turn('item:t2', 'mail', 'completed', 'Mail.')],
      [...sends, submissionOf('mail', { submittedAt: NOW })]
    )
    p.recovery.turnEnded('chat-1')
    await p.publish()
    expect(p.outcomes().d1).toEqual({ outcome: 'unattributed', head: 'd1' })
  })

  it('leaves a send still queued for handover owed when an unrelated turn ends', async () => {
    vi.setSystemTime(NOW - 60_000)
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    admit(p.db, 'other', unrelated)
    p.show(
      [p.message('m1'), ...p.turn('item:t1', 'other', 'completed', 'Unrelated answer.')],
      [submissionOf('m1', { dispatchState: 'pending', submittedAt: NOW, handoverRecorded: true })]
    )
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
  })
})

describe('the reply names the turn that answered it', () => {
  const TURN_AT = NOW - 30_000
  const owedEvents = async (journal: ConnectorReplyCutJournal) =>
    replyEventsOf(
      (await journal.readOwed('account-a', '', 50)).flatMap((row) =>
        row.fill ? [{ ...row, fill: row.fill }] : []
      )
    )

  it('a send steered into a turn goes out with the turn its live end knew', async () => {
    const p = start()
    admit(p.db, 'm1', asked('d1'))
    admit(p.db, 'm2', asked('d2'))
    const submissions = [
      submissionOf('m1', { answeredInTurn: { turnItemId: 'item:t1', via: 'start' } }),
      submissionOf('m2', { answeredInTurn: { turnItemId: 'item:t1', via: 'steer' } })
    ]
    const items = [p.message('m1'), p.message('m2'), ...p.turn('item:t1', 'm1', 'completed')]
    const opener = p.message('m1')
    await p.fillTurn({
      sessionId: 'chat-1',
      turnItemId: 'item:t1',
      stamps: connectorReplyTurnStamps({ items, submissions }, opener, 'item:t1'),
      openerItemId: opener.itemId,
      outcome: 'success',
      prose: 'Both.',
      bot: false,
      links: [],
      turnStartedAt: TURN_AT
    })
    // Read back after a reopen: the turn is the row's, not the live process's.
    p.db.close()
    const after = start()
    expect(await owedEvents(after.journal)).toEqual([
      expect.objectContaining({ deliveryIds: ['d1', 'd2'], outcome: 'answered', turnId: TURN_AT })
    ])
  })

  it('a /replies post after a restart names the same turn, or the fill time when none was known', async () => {
    const before = start()
    for (const [id, turnStartedAt] of [
      ['d1', TURN_AT],
      ['d2', undefined]
    ] as const) {
      admit(before.db, `m-${id}`, asked(id))
      await before.fillTurn({
        sessionId: 'chat-1',
        turnItemId: `item:${id}`,
        stamps: [stampOf(id)],
        outcome: 'success',
        prose: 'Done.',
        bot: false,
        links: [],
        ...(turnStartedAt === undefined ? {} : { turnStartedAt })
      })
    }
    before.db.close()
    const after = start()
    const posted: ConnectorReplyBody[] = []
    const outbox = new ConnectorReplyOutbox('account-a', () => after.journal, {
      owed: () => {},
      wake: () => {},
      route: () => ({
        outbox: false,
        client: {
          hostName: () => 'laptop',
          push: () => {},
          post: async (body) => {
            posted.push(body)
            return { ok: true, value: {} }
          }
        }
      })
    })
    await outbox.drain()
    outbox.retire()
    expect(posted.map(({ answerDeliveryId, turnId }) => [answerDeliveryId, turnId])).toEqual([
      ['d1', TURN_AT],
      ['d2', NOW]
    ])
  })

  it('a turn recovery filled at boot names none, so the cloud keeps its own reading', async () => {
    const before = start()
    admit(before.db, 'm1', asked('d1'))
    before.db.close()
    const p = start({ continuationsSettled: Promise.resolve() })
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed', 'Done.')])
    await p.recovery.boot()
    const [event] = await owedEvents(p.journal)
    expect(event).toMatchObject({ deliveryIds: ['d1'], outcome: 'answered' })
    expect(event).not.toHaveProperty('turnId')
  })
})
