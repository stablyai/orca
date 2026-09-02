import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stripNoiseMessages } from '../../shared/native-chat-noise'
import { foldToolMessages, pairToolBlocks } from '../../shared/native-chat-tool-fold'
import { isToolCallBlock, isToolResultBlock } from '../../shared/native-chat-types'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeTranscript(records: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-attribution-'))
  tempRoots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
  return filePath
}

/** One Claude turn: the assistant's `tool_use` record, then the user-role record
 *  carrying its `tool_result` — the shape every Claude transcript writes. */
function toolTurn(n: number): unknown[] {
  return [
    {
      type: 'assistant',
      uuid: `call-${n}`,
      timestamp: `2026-08-20T10:00:${String(n).padStart(2, '0')}.000Z`,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${n}` } }]
      }
    },
    {
      type: 'user',
      uuid: `result-${n}`,
      timestamp: `2026-08-20T10:00:${String(n).padStart(2, '0')}.500Z`,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: `output ${n}`, tool_use_id: `toolu_${n}` }]
      }
    }
  ]
}

/** The rendered defect: a tool row with output but no call to attribute it to.
 *  Mirrors what both chat views build from a folded message's tool blocks. */
function unattributedResults(messages: readonly NativeChatMessage[]): string[] {
  const stray: string[] = []
  for (const message of messages) {
    const tools = message.blocks.filter(
      (block) => isToolCallBlock(block) || isToolResultBlock(block)
    )
    if (tools.length === 0) {
      continue
    }
    for (const pair of pairToolBlocks(tools)) {
      if (pair.call === undefined && pair.result) {
        stray.push(pair.result.output)
      }
    }
  }
  return stray
}

async function renderedMessages(filePath: string, limit: number): Promise<NativeChatMessage[]> {
  const page = await readNativeChatTranscriptTailFile(
    filePath,
    limit,
    decodeClaudeTranscriptLine,
    true
  )
  return stripNoiseMessages(foldToolMessages(page.messages))
}

describe('windowed transcript tool attribution', () => {
  it('drops a tool result whose call falls outside the read window', async () => {
    const filePath = await writeTranscript([...toolTurn(1), ...toolTurn(2), ...toolTurn(3)])

    // A 3-message window cuts turn 2 in half: its result is the oldest record in
    // the window, its `tool_use` is not.
    const windowed = await renderedMessages(filePath, 3)

    expect(unattributedResults(windowed)).toEqual([])
    // The turn that survives whole still renders its output.
    expect(
      windowed.flatMap((message) =>
        message.blocks.filter(isToolResultBlock).map((block) => block.output)
      )
    ).toEqual(['output 3'])
  })

  it('keeps every result when the window contains its call', async () => {
    const filePath = await writeTranscript([...toolTurn(1), ...toolTurn(2)])

    const whole = await renderedMessages(filePath, 100)

    expect(unattributedResults(whole)).toEqual([])
    expect(
      whole.flatMap((message) =>
        message.blocks.filter(isToolResultBlock).map((block) => block.output)
      )
    ).toEqual(['output 1', 'output 2'])
  })

  it('drops the answered result records Claude re-emits at a /compact boundary', async () => {
    // Claude appends byte-identical copies of already-answered tool_result
    // records after a compaction, with no `tool_use` in between.
    const [, answeredResult] = toolTurn(1)
    const filePath = await writeTranscript([
      ...toolTurn(1),
      {
        type: 'user',
        uuid: 'compact-prompt',
        timestamp: '2026-08-20T10:05:00.000Z',
        message: { role: 'user', content: '/compact' }
      },
      answeredResult
    ])

    const whole = await renderedMessages(filePath, 100)

    expect(unattributedResults(whole)).toEqual([])
    expect(
      whole.flatMap((message) =>
        message.blocks.filter(isToolResultBlock).map((block) => block.output)
      )
    ).toEqual(['output 1'])
  })

  it('keeps a hidden interruption from authorizing a later result', async () => {
    const [abandonedCall] = toolTurn(1)
    const [, laterResult] = toolTurn(2)
    const filePath = await writeTranscript([
      abandonedCall,
      {
        type: 'user',
        uuid: 'interrupt',
        timestamp: '2026-08-20T10:01:00.000Z',
        message: { role: 'user', content: '[Request interrupted by user]' }
      },
      laterResult
    ])

    const messages = await renderedMessages(filePath, 100)

    expect(unattributedResults(messages)).toEqual([])
    expect(messages.map((message) => message.id)).toEqual(['call-1'])
  })
})
