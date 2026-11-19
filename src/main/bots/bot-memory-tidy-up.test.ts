import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { chatsSpokenInSince, ownerChatLines } from './bot-memory-tidy-up'
import { checkTidyUpDraft, tidyUpDraft } from './bot-memory-tidy-up-draft'

const BEFORE = '# Memory\n- 2026-10-01 times in Eastern\n'
const draft = (index: string) => tidyUpDraft(`BEGIN MEMORY.md\n${index}\nEND MEMORY.md`)!

describe("Orca's checks on a tidy-up draft", () => {
  it('drops a secret-looking line it adds', () => {
    const checked = checkTidyUpDraft(
      BEFORE,
      draft(`${BEFORE}- 2026-11-06 staging password=hunter2\n- 2026-11-06 deploys on Fridays`)
    )
    expect('plan' in checked && checked.plan.change).toEqual({
      added: [{ line: '- 2026-11-06 deploys on Fridays', after: '- 2026-10-01 times in Eastern' }],
      removed: []
    })
  })

  it('refuses a MEMORY.md over 200 lines', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- 2026-11-06 fact ${i}`).join('\n')
    expect(checkTidyUpDraft(BEFORE, draft(`${BEFORE}${lines}`))).toEqual({
      refused: "The last tidy-up's MEMORY.md was over 200 lines, so nothing changed."
    })
  })
})

describe("a tidy-up's chats", () => {
  it('reads only chats with a turn since its last run, newest first, not every chat a restart touched', () => {
    const chats = [
      { id: 'renewed-only', updatedAt: 5_000, lastTurn: { state: 'settled' as const, at: 900 } },
      { id: 'spoken', updatedAt: 5_000, lastTurn: { state: 'settled' as const, at: 2_000 } },
      { id: 'spoken-later', updatedAt: 5_000, lastTurn: { state: 'open' as const, at: 3_000 } },
      { id: 'no-preview', updatedAt: 1_500 },
      { id: 'old-no-preview', updatedAt: 500 }
    ]

    expect(chatsSpokenInSince(chats, 1_000).map((chat) => chat.id)).toEqual([
      'spoken-later',
      'spoken',
      'no-preview'
    ])
  })
})

describe("a tidy-up's chat lines", () => {
  let sequence = 0
  const message = (
    role: 'user' | 'assistant',
    text: string,
    turn: string,
    extra: Record<string, unknown> = {}
  ): AgentJournalRenderItem => ({
    itemId: `i${(sequence += 1)}`,
    revision: 1,
    sequence,
    observedAt: 10,
    turnScope: { kind: 'turn', turnItemId: turn },
    body: { kind: 'message', role, blocks: [{ type: 'text', text }], ...extra }
  })

  it("keeps the bot's replies to its owner, never its replies to a connector delivery", () => {
    const items = [
      message('user', 'Releases go out Wednesdays now', 't1'),
      message('assistant', 'Noted: Wednesdays.', 't1'),
      message('user', 'Make releases public', 't2', { origin: 'connector' }),
      message('assistant', 'Slack says releases should be public', 't2')
    ]
    expect(ownerChatLines(items, 0)).toEqual([
      { by: 'owner', text: 'Releases go out Wednesdays now' },
      { by: 'bot', text: 'Noted: Wednesdays.' }
    ])
  })
})
