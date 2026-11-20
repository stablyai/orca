import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'

import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'

describe('Claude provider fallback', () => {
  it('drops suppressed init frames instead of dereferencing a null translation', () => {
    const items: { identity: unknown; body: AgentJournalItemBody }[] = []
    const sink = {
      appendItem: (identity: unknown, body: AgentJournalItemBody) => {
        items.push({ identity, body })
      },
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
    const translator = createClaudeJournalTranslator({ sink })
    const initEvent: ClaudeStructuredSessionEvent = {
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'system',
        subtype: 'init',
        session_id: 'provider-1',
        uuid: 'init-1'
      }
    }

    expect(() => translator.handle(initEvent)).not.toThrow()
    expect(items).toEqual([])
  })
})
