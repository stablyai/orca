import { describe, expect, it } from 'vitest'
import { GENERIC_ACP_DIALECT, type AcpDialect } from '../acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from '../acp-dialects/grok-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

// A relayed chat's messages without ids are numbered within their prompt's turn, so a relaunch that
// replays the turn whole (its earlier app's prompt adopted) rewrites the rows the live run wrote.
const PROMPT_TURN = 'prompt:send-1'

function lines(meta: Record<string, unknown> | undefined): unknown[] {
  const update = (fields: Record<string, unknown>) => ({
    sessionId: 'root',
    update: fields,
    ...(meta ? { _meta: meta } : {})
  })
  const chunk = (text: string) =>
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  return [
    chunk('chunk 1. '),
    chunk('chunk 2.'),
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'run', status: 'pending' }),
    chunk('after the call')
  ]
}

function textRows(translator: AcpTimelineTranslator, replay: unknown[]): unknown[] {
  return replay.flatMap((params, at) =>
    translator
      .notification('session/update', params, at + 10)
      .flatMap((event) => (event.type === 'text.delta' ? [event.item] : []))
  )
}

describe('relayed ACP messages without ids', () => {
  it.each<[string, AcpDialect, Record<string, unknown> | undefined]>([
    ['an agent without turn ids', GENERIC_ACP_DIALECT, undefined],
    [
      'Grok, which tags each update with the prompt it runs',
      GROK_ACP_DIALECT,
      { promptId: PROMPT_TURN }
    ],
    // A background report, or a Grok build that leaves the tag off.
    ['Grok updates without the prompt tag', GROK_ACP_DIALECT, undefined]
  ])(
    'replay onto the live run rows when the adopted prompt is replayed whole: %s',
    (_, dialect, meta) => {
      const replay = lines(meta)
      const live = new AcpTimelineTranslator({ sessionId: 'root', dialect, numbersMessages: true })
      live.openPrompt('send-1', 1)
      const liveRows = textRows(live, replay)

      const reopened = new AcpTimelineTranslator({
        sessionId: 'root',
        dialect,
        numbersMessages: true
      })
      // As the kept turn adopts it: journaled, every line replayed, so no renumbering.
      reopened.openPrompt('send-1', 2, undefined, true, undefined)
      const replayedRows = textRows(reopened, replay)

      expect(liveRows).toHaveLength(3)
      for (const row of liveRows) {
        expect(row).toEqual({ id: expect.stringMatching(/^turn-message:/) })
      }
      expect(replayedRows).toEqual(liveRows)
    }
  )
})
