import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { projectStructuredItemToNativeChat } from '@orca/test-host/shared/agent-session/view/structured-agent-session-projection'
import {
  createNativeChatMerger,
  applyAppend
} from '@orca/test-host/shared/native-chat/native-chat-merge'
import { decodeClaudeTranscriptLine } from '@orca/test-host/main/native-chat/transcript-line-decoders-claude'
import { readCodexThreadItem } from '@orca/test-host/main/codex/structured/items/codex-thread-item-identity'
import { codexJournalItem } from '@orca/test-host/main/codex/structured/items/codex-structured-item-translation'
import { projectMobileNativeChatMessages } from '@orca/test-mobile/session/native-chat/transcript/mobile-native-chat-projection'

it('preserves captured agent output through legacy appends', () => {
  const claude = readFileSync(
    new URL(
      '../../../../../src/main/claude/__fixtures__/claude-adapter-capture-fold.jsonl',
      import.meta.url
    ),
    'utf8'
  )
    .trim()
    .split('\n')
    .flatMap((line, index) => {
      const record = JSON.parse(line)
      const message = record.frame
        ? decodeClaudeTranscriptLine(JSON.stringify(record.frame), `capture-${index}`)
        : null
      return message ? [message] : []
    })
  const codex = readFileSync(
    new URL(
      '../../../../../src/main/codex/__fixtures__/codex-hook-outcomes.jsonl',
      import.meta.url
    ),
    'utf8'
  )
    .trim()
    .split('\n')
    .flatMap((line, index) => {
      const parsed = JSON.parse(line)
      const frame = parsed.frame ?? parsed
      const item =
        frame?.method === 'item/completed' ? readCodexThreadItem(frame.params?.item) : null
      const body = item ? codexJournalItem(item).body : null
      const message = body
        ? projectStructuredItemToNativeChat({
            itemId: `capture-${index}`,
            sequence: index,
            revision: 1,
            observedAt: index,
            body
          })
        : null
      return message ? [message] : []
    })
  for (const [agent, records] of [
    ['claude', claude],
    ['codex', codex]
  ] as const) {
    const merger = createNativeChatMerger()
    let state = projectMobileNativeChatMessages([], agent)
    for (const message of records) {
      const input = applyAppend(merger, [message])
      state = projectMobileNativeChatMessages(input, agent, state)
    }
    expect(state.rows.at(-1)?.blocks).toEqual([
      {
        type: 'text',
        text:
          agent === 'claude'
            ? 'FIRST DONE banana'
            : 'The command was blocked by an automatic hook stating “Deploys are frozen,” so it printed nothing.'
      }
    ])
  }
})
