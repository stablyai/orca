import { describe, expect, it } from 'vitest'
import { GENERIC_ACP_DIALECT, type AcpDialect } from '../acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from '../acp-dialects/grok-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

// A relayed chat's messages without ids are numbered within their prompt's turn, so a relaunch that
// replays the turn whole (its earlier app's prompt adopted) rewrites the rows the live run wrote.
const PROMPT_TURN = 'prompt:send-1'

type Tag = Record<string, unknown> | undefined
const TAG: Tag = { promptId: PROMPT_TURN }

/** `tags`: each line's prompt tag, in order. */
function lines(tags: readonly Tag[]): unknown[] {
  const update = (at: number, fields: Record<string, unknown>) => ({
    sessionId: 'root',
    update: fields,
    ...(tags[at] ? { _meta: tags[at] } : {})
  })
  const chunk = (at: number, text: string) =>
    update(at, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  return [
    chunk(0, 'chunk 1. '),
    chunk(1, 'chunk 2.'),
    update(2, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'run',
      status: 'pending'
    }),
    chunk(3, 'after the call')
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
  it.each<[string, AcpDialect, Tag[]]>([
    ['an agent without turn ids', GENERIC_ACP_DIALECT, []],
    [
      'Grok, which tags each update with the prompt it runs',
      GROK_ACP_DIALECT,
      [TAG, TAG, TAG, TAG]
    ],
    // A background report, or a Grok build that leaves the tag off.
    ['Grok updates without the prompt tag', GROK_ACP_DIALECT, []],
    // Untagged text, then the prompt's tagged text: live, the turn opens only at the tag.
    ['Grok text untagged, then tagged', GROK_ACP_DIALECT, [undefined, TAG, TAG, TAG]]
  ])(
    'replay onto the live run rows when the adopted prompt is replayed whole: %s',
    (_, dialect, tags) => {
      const replay = lines(tags)
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
      // The call splits the text into two messages.
      expect(new Set(liveRows.map((row) => JSON.stringify(row))).size).toBe(2)
      expect(replayedRows).toEqual(liveRows)
    }
  )
})
