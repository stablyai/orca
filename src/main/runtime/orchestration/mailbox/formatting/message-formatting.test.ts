import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../db/orchestration-records'
import type { BotRequestRecord } from '../../../../bots/bot-request-view'
import { peerMailSenderSnapshot } from '../../federation/peer-mail/peer-mail-sender-snapshot'
import {
  formatMessageBanner,
  formatMessageBannerWithContent,
  type MessageFormattingOptions
} from './message-formatting'

const PAIRED_LABEL = 'orca_session_id:f2d72b85-0000-4000-8000-000000000000 on MacBook Pro (7)'

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg_1',
    run_id: 'run_1',
    from_handle: 'term_abc',
    to_handle: 'orca_session_id:11111111-1111-4111-8111-111111111111',
    subject: 'Review the sidebar change',
    body: 'Please look at the diff.',
    type: 'handoff',
    priority: 'normal',
    thread_id: null,
    payload: null,
    read: 0,
    sequence: 1,
    created_at: '2026-11-21T00:00:00.000Z',
    delivered_at: null,
    sender_pane_key: null,
    ...overrides
  }
}

const header = (row: MessageRow, options: MessageFormattingOptions = {}) =>
  formatMessageBanner(row, options).split('\n')[0]

const linkedPeer = (row: MessageRow): MessageFormattingOptions => ({
  peerMail: {
    getPeerMailMessage: (id) => (id === row.id ? { sender_label: row.from_handle } : undefined),
    getBotRequest: () => undefined
  }
})

describe('the mail header', () => {
  it("names this Orca's own sender by its handle, as before", () => {
    expect(header(message())).toBe('──── From: TERM_ABC (term_abc) (handoff) ────')
  })

  it("names a paired computer's bot, or an agent there, never its raw address", () => {
    const fromBot = message({
      from_handle: PAIRED_LABEL,
      answer_sender_snapshot: peerMailSenderSnapshot(PAIRED_LABEL, {
        name: 'Fix the sidebar',
        computer: 'MacBook Pro (7)',
        bot: { id: 'eng', name: 'Eng-Bot-Builder', avatar: null }
      })
    })
    expect(header(fromBot, linkedPeer(fromBot))).toBe(
      '──── From: Eng-Bot-Builder on MacBook Pro (7) (handoff) ────'
    )
    const fromAgent = message({
      from_handle: PAIRED_LABEL,
      answer_sender_snapshot: peerMailSenderSnapshot(PAIRED_LABEL, {
        name: 'Fix RAM',
        computer: "Brennan's MacBook Pro"
      })
    })
    expect(header(fromAgent, linkedPeer(fromAgent))).toBe(
      "──── From: an agent on Brennan's MacBook Pro (handoff) ────"
    )
  })

  it('names an older paired Orca that sent no sender by the computer its label gives', () => {
    const older = message({ from_handle: PAIRED_LABEL })
    expect(header(older, linkedPeer(older))).toBe(
      '──── From: an agent on MacBook Pro (7) (handoff) ────'
    )
  })

  it('uses the recorded origin to tell identical local and paired sender labels apart', () => {
    const row = message({ from_handle: 'Build on Call', type: 'status' })
    expect(
      header(row, {
        peerMail: { getPeerMailMessage: () => undefined, getBotRequest: () => undefined }
      })
    ).toBe('──── From: BUILD ON CALL (Build on Call) (status) ────')
    expect(header(row, linkedPeer(row))).toBe('──── From: an agent on Call (status) ────')
  })

  it("names a paired bot request as its own record does, over the sender's own snapshot", () => {
    const pulled = message({
      from_handle: PAIRED_LABEL,
      answer_sender_snapshot: peerMailSenderSnapshot(PAIRED_LABEL, {
        name: 'Ranger',
        computer: 'Lab Mac',
        bot: { id: 'ranger', name: 'Ranger', avatar: null }
      })
    })
    const recorded = (
      record: Pick<
        BotRequestRecord,
        'fromBotName' | 'fromPairedComputer' | 'fromPairedServer' | 'fromComputer'
      >
    ): MessageFormattingOptions => ({
      peerMail: {
        ...linkedPeer(pulled).peerMail!,
        getBotRequest: (id) =>
          id === pulled.id ? { record: JSON.stringify({ fromBotId: null, ...record }) } : undefined
      }
    })
    expect(
      header(pulled, recorded({ fromBotName: 'Ranger', fromPairedComputer: 'Build Box' }))
    ).toBe('──── From: Ranger on Build Box (handoff) ────')
    expect(header(pulled, recorded({ fromBotName: null, fromPairedComputer: '' }))).toBe(
      '──── From: an agent on another computer (handoff) ────'
    )
    // A local bot's request names no paired computer, so the label decides as before.
    expect(header(pulled, recorded({ fromBotName: 'Docs' }))).toBe(
      '──── From: Ranger on Lab Mac (handoff) ────'
    )
  })

  it('names a paired sender from records saved in the older shapes', () => {
    const row = message({
      from_handle: PAIRED_LABEL,
      answer_sender_snapshot: peerMailSenderSnapshot(PAIRED_LABEL, {
        name: 'Ranger',
        computer: 'Lab Mac',
        bot: { id: 'ranger', name: 'Ranger', avatar: null }
      })
    })
    const saved = (record: string): MessageFormattingOptions => ({
      peerMail: {
        ...linkedPeer(row).peerMail!,
        getBotRequest: () => ({ record })
      }
    })
    const legacy = (
      fields: Pick<BotRequestRecord, 'fromBotName' | 'fromPairedServer' | 'fromComputer'>
    ) => saved(JSON.stringify({ fromBotId: null, ...fields }))
    expect(header(row, legacy({ fromBotName: null, fromPairedServer: 'Build Box' }))).toBe(
      '──── From: an agent on Build Box (handoff) ────'
    )
    expect(header(row, legacy({ fromBotName: null, fromPairedServer: '' }))).toBe(
      '──── From: an agent on another computer (handoff) ────'
    )
    expect(header(row, legacy({ fromBotName: 'Ranger', fromComputer: 'Review Laptop' }))).toBe(
      '──── From: Ranger on Review Laptop (handoff) ────'
    )
    expect(header(row, legacy({ fromBotName: null, fromComputer: null }))).toBe(
      '──── From: an agent on another computer (handoff) ────'
    )
    // A record this host cannot read leaves the label and snapshot to decide.
    expect(header(row, saved('not json'))).toBe('──── From: Ranger on Lab Mac (handoff) ────')
  })

  it('keeps priority and authority tags beside a paired sender', () => {
    const urgent = message({
      from_handle: PAIRED_LABEL,
      priority: 'urgent',
      delivery_contract: 'legacy_direct'
    })
    expect(header(urgent, linkedPeer(urgent))).toBe(
      '──── From: an agent on MacBook Pro (7) [URGENT] [LEGACY READ-ONLY] (handoff) ────'
    )
  })

  it("points the subject and body ranges at their text under a paired sender's header", () => {
    const row = message({
      from_handle: PAIRED_LABEL,
      priority: 'high',
      answer_sender_snapshot: peerMailSenderSnapshot(PAIRED_LABEL, {
        name: null,
        computer: 'MacBook Pro (7)'
      })
    })
    const { text, content } = formatMessageBannerWithContent(row, linkedPeer(row))
    expect(text.split('\n')[0]).toBe('──── From: an agent on MacBook Pro (7) [HIGH] (handoff) ────')
    expect(text.slice(...content.subject)).toBe(row.subject)
    expect(text.slice(...content.body!)).toBe(row.body)
  })
})
