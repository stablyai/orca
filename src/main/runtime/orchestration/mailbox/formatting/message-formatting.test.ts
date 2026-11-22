import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../db/orchestration-records'
import { peerMailSenderSnapshot } from '../../federation/peer-mail/peer-mail-sender-snapshot'
import { formatMessageBanner, formatMessageBannerWithContent } from './message-formatting'

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

const header = (row: MessageRow) => formatMessageBanner(row).split('\n')[0]

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
    expect(header(fromBot)).toBe('──── From: Eng-Bot-Builder on MacBook Pro (7) (handoff) ────')
    const fromAgent = message({
      from_handle: PAIRED_LABEL,
      answer_sender_snapshot: peerMailSenderSnapshot(PAIRED_LABEL, {
        name: 'Fix RAM',
        computer: "Brennan's MacBook Pro"
      })
    })
    expect(header(fromAgent)).toBe("──── From: an agent on Brennan's MacBook Pro (handoff) ────")
  })

  it('names an older paired Orca that sent no sender by the computer its label gives', () => {
    const older = message({ from_handle: PAIRED_LABEL })
    expect(header(older)).toBe('──── From: an agent on MacBook Pro (7) (handoff) ────')
    expect(header(older)).not.toMatch(/orca_session_id/i)
  })

  it('keeps priority and authority tags beside a paired sender', () => {
    const urgent = message({
      from_handle: PAIRED_LABEL,
      priority: 'urgent',
      delivery_contract: 'legacy_direct'
    })
    expect(header(urgent)).toBe(
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
    const { text, content } = formatMessageBannerWithContent(row)
    expect(text.split('\n')[0]).toBe('──── From: an agent on MacBook Pro (7) [HIGH] (handoff) ────')
    expect(text.slice(...content.subject)).toBe(row.subject)
    expect(text.slice(...content.body!)).toBe(row.body)
  })
})
