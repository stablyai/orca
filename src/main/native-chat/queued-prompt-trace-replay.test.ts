import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isTextBlock, type NativeChatMessage } from '../../shared/native-chat-types'
import { QUEUED_PROMPT_TRACE, QUEUED_PROMPT_TEXT } from './__fixtures__/queued-prompt-trace'
import { readIncrementalTranscriptMessages } from './transcript-incremental-reader'
import { readNativeChatTranscript } from './transcript-reader'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function tempTranscript(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-queued-prompt-trace-'))
  tempRoots.push(root)
  return join(root, 'transcript.jsonl')
}

function textOf(message: NativeChatMessage): string {
  return message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(' ')
    .trim()
}

/** Thinking and tool rows carry no conversation text; this is what a person reads. */
function conversationTexts(messages: readonly NativeChatMessage[]): string[] {
  return messages
    .map(textOf)
    .filter((text) => text.startsWith('ASSISTANT_TEXT') || text === QUEUED_PROMPT_TEXT)
}

async function replay(lines: readonly string[]): Promise<NativeChatMessage[]> {
  const filePath = await tempTranscript()
  await writeFile(filePath, `${lines.join('\n')}\n`)
  const result = await readNativeChatTranscript('claude', 'replay', { filePath })
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result.messages
}

describe('a prompt sent while the agent was mid-turn', () => {
  it('lands between the turns that bracket it', async () => {
    expect(conversationTexts(await replay(QUEUED_PROMPT_TRACE))).toStrictEqual([
      'ASSISTANT_TEXT_1',
      QUEUED_PROMPT_TEXT,
      'ASSISTANT_TEXT_2'
    ])
  })

  it('arrives once, as a queued user turn', async () => {
    const carrying = (await replay(QUEUED_PROMPT_TRACE)).filter(
      (message) => textOf(message) === QUEUED_PROMPT_TEXT
    )

    expect(carrying).toHaveLength(1)
    expect(carrying[0]).toMatchObject({ role: 'user', queued: true, source: 'transcript' })
  })

  it('stays out when the attachment is one the agent queued for itself', async () => {
    const lines = QUEUED_PROMPT_TRACE.map((line) =>
      line.includes('"queued_command"')
        ? line.replace('"commandMode":"prompt"', '"commandMode":"task-notification"')
        : line
    )

    expect(conversationTexts(await replay(lines))).toStrictEqual([
      'ASSISTANT_TEXT_1',
      'ASSISTANT_TEXT_2'
    ])
  })

  it('lands the same way when the records arrive while the pane is open', async () => {
    // The field case is an append into an open pane, not a cold read: the
    // attachment reaches the reader in a later batch than the turn it follows.
    const filePath = await tempTranscript()
    const split = QUEUED_PROMPT_TRACE.findIndex((line) => line.includes('"queued_command"'))
    const state = {
      offset: 0,
      pendingChunks: [],
      pendingStart: 0,
      pendingBytes: 0,
      droppingOversizedRecord: false
    }
    const decode = nativeChatLineDecoderForAgent('claude')
    if (!decode) {
      throw new Error('no claude decoder')
    }

    await writeFile(filePath, `${QUEUED_PROMPT_TRACE.slice(0, split).join('\n')}\n`)
    const before = await readIncrementalTranscriptMessages(filePath, state, decode)
    await appendFile(filePath, `${QUEUED_PROMPT_TRACE.slice(split).join('\n')}\n`)
    const after = await readIncrementalTranscriptMessages(filePath, state, decode)

    expect(conversationTexts([...before, ...after])).toStrictEqual([
      'ASSISTANT_TEXT_1',
      QUEUED_PROMPT_TEXT,
      'ASSISTANT_TEXT_2'
    ])
  })
})
