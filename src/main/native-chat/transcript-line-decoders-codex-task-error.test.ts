import { describe, expect, it } from 'vitest'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

// 2026-08 實際擷取的 Codex provider 額度訊息（task_complete.error.message 原文）。
const REAL_PROVIDER_QUOTA_SAMPLE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 11:32 AM."

describe('Codex task_complete provider 錯誤解碼', () => {
  it('把 task_complete.error.message 呈現為 runtime 署名的 system 訊息', () => {
    const message = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-08T03:32:00.000Z',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: null,
          error: {
            message: REAL_PROVIDER_QUOTA_SAMPLE,
            codex_error_info: 'usage_limit_reached'
          }
        }
      }),
      'fallback'
    )

    expect(message?.role).toBe('system')
    expect(message?.blocks).toEqual([{ type: 'text', text: REAL_PROVIDER_QUOTA_SAMPLE }])
    expect(message?.source).toBe('transcript')
  })

  it('也接受字串型的 task_complete.error', () => {
    const message = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1', error: 'Usage limit reached.' }
      }),
      'fallback'
    )

    expect(message?.role).toBe('system')
    expect(message?.blocks).toEqual([{ type: 'text', text: 'Usage limit reached.' }])
  })

  it('無錯誤的 task_complete 不產生任何訊息，避免灌水 transcript', () => {
    const message = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '完成' }
      }),
      'fallback'
    )

    expect(message).toBeNull()
  })
})
