import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { surfaceNativeChatCommandOutputs } from '../../shared/native-chat-command-output'
import { stripNoiseMessages } from '../../shared/native-chat-noise'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

// OpenClaude 0.31.0 running `/context`, `/cost`, `/context` with no model call;
// session id and cwd scrubbed. `/cost` replies in a `system` row.
const FIXTURE_LINES = readFileSync(
  join(__dirname, '__fixtures__', 'openclaude-0.31.0-local-command-rows.jsonl'),
  'utf8'
)
  .split('\n')
  .filter((line) => line.trim() !== '')

function decoded(lines: readonly string[]): NativeChatMessage[] {
  return lines.flatMap((line, index) => decodeClaudeTranscriptLine(line, `f${index}`) ?? [])
}

function commandRow(messages: NativeChatMessage[], index: number): NativeChatMessage | undefined {
  return messages.filter((message) =>
    message.blocks.some((block) => block.type === 'text' && block.text.includes('<command-name>'))
  )[index]
}

describe("OpenClaude's local command rows through the transcript decoder", () => {
  const messages = decoded(FIXTURE_LINES)

  it("links each reply row to its command row's id", () => {
    const replies = messages.filter((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.text.includes('<local-command-stdout>')
      )
    )
    expect(replies.map(({ parentId }) => parentId)).toEqual([
      commandRow(messages, 0)?.id,
      commandRow(messages, 2)?.id
    ])
  })

  it('shows both /context reports as plain command output and nothing else', () => {
    const visible = stripNoiseMessages(surfaceNativeChatCommandOutputs(messages, 'openclaude'))
    expect(visible.map(({ role }) => role)).toEqual(['system', 'system'])
    const totals = visible.map(({ blocks: [block] }) => {
      expect(block).toMatchObject({ type: 'text', presentation: 'command-output' })
      const text = block?.type === 'text' ? block.text : ''
      expect(text.split('\n')[0]).toBe('Context Usage')
      expect(text).not.toContain('\u001b')
      return /gpt-4o · \S+ tokens \(\d+%\)/.exec(text)?.[0]
    })
    expect(totals).toEqual(['gpt-4o · 18.3k/128k tokens (14%)', 'gpt-4o · 18.9k/128k tokens (15%)'])
  })

  it('keeps the reply hidden for a host that sends no row link', () => {
    const unlinked = messages.map(({ parentId: _parentId, ...message }) => message)
    expect(stripNoiseMessages(surfaceNativeChatCommandOutputs(unlinked, 'openclaude'))).toEqual([])
  })
})
