import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readNativeChatTranscript } from './transcript-reader'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTail,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'
import { subscribeNativeChatTranscript } from './transcript-watch'
import {
  createCodexTranscriptLineDecoder,
  resetCodexTranscriptLineDecoder
} from './transcript-line-decoders-codex'

const EVENT_TIMESTAMP = '2026-08-07T04:00:00.000Z'
const RESPONSE_TIMESTAMP = '2026-08-07T04:00:00.006Z'
const TEXT = 'The external state has not changed'
let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function eventMessage(
  text: string,
  role: 'user' | 'assistant' = 'assistant',
  timestamp = EVENT_TIMESTAMP
): unknown {
  return {
    type: 'event_msg',
    timestamp,
    payload: { type: role === 'user' ? 'user_message' : 'agent_message', message: text }
  }
}

function responseMessage(
  text: string,
  role: 'user' | 'assistant' = 'assistant',
  timestamp = RESPONSE_TIMESTAMP,
  blockType = role === 'user' ? 'input_text' : 'output_text'
): unknown {
  return {
    type: 'response_item',
    timestamp,
    payload: {
      id: `msg-${role}-${text}`,
      type: 'message',
      role,
      content: [{ type: blockType, text }]
    }
  }
}

async function writeFixture(records: unknown[], trailingNewline = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-mirror-dedup-'))
  tempRoots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  const content = records.map((record) => JSON.stringify(record)).join('\n')
  await writeFile(filePath, trailingNewline ? `${content}\n` : content)
  return filePath
}

function textOf(message: { blocks: { type: string; text?: string }[] }): string {
  const block = message.blocks[0]
  return block?.type === 'text' ? (block.text ?? '') : ''
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Codex mirrored transcript messages', () => {
  it('resets the paginated mode when a watched transcript is replaced', () => {
    const decode = createCodexTranscriptLineDecoder()
    const sessionMeta = JSON.stringify({
      type: 'session_meta',
      payload: { history_mode: 'paginated' }
    })
    const response = JSON.stringify(responseMessage(TEXT))

    expect(decode(sessionMeta, 'meta')).toBeNull()
    expect(decode(response, 'paginated-copy')).toBeNull()

    resetCodexTranscriptLineDecoder(decode)

    expect(decode(response, 'legacy-message')).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: TEXT }]
    })
  })

  it('collapses adjacent event and response records despite timestamp drift', async () => {
    const filePath = await writeFixture([
      eventMessage('Continue', 'user'),
      responseMessage('Continue', 'user'),
      eventMessage(TEXT),
      responseMessage(TEXT)
    ])

    const result = await readNativeChatTranscript('codex', 'paired', { filePath })

    expect('messages' in result && result.messages.map(textOf)).toEqual(['Continue', TEXT])
  })

  it('keeps deliberate repeated records from the same Codex format', async () => {
    const filePath = await writeFixture([eventMessage(TEXT), eventMessage(TEXT)])

    const result = await readNativeChatTranscript('codex', 'repeated', { filePath })

    expect('messages' in result && result.messages.map(textOf)).toEqual([TEXT, TEXT])
  })

  it('collapses the legacy response text block emitted beside an event', async () => {
    const filePath = await writeFixture([
      eventMessage(TEXT),
      responseMessage(TEXT, 'assistant', RESPONSE_TIMESTAMP, 'text')
    ])

    const result = await readNativeChatTranscript('codex', 'legacy-text', { filePath })

    expect('messages' in result && result.messages.map(textOf)).toEqual([TEXT])
  })

  it('collapses a mirrored user response that also carries an image block', async () => {
    const response = responseMessage('Continue', 'user') as {
      payload: { content: unknown[] }
    }
    response.payload.content.push({ type: 'input_image', image_url: 'data:image/png;base64,eA==' })
    const filePath = await writeFixture([eventMessage('Continue', 'user'), response])

    const result = await readNativeChatTranscript('codex', 'user-image-pair', { filePath })
    const tail = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: 'user-image-pair',
      filePath,
      limit: 10
    })

    expect(result).toMatchObject({
      messages: [
        {
          role: 'user',
          blocks: [
            { type: 'text', text: 'Continue' },
            { type: 'image-ref', url: 'data:image/png;base64,eA==' }
          ]
        }
      ]
    })
    expect(tail).toMatchObject({ messages: 'messages' in result ? result.messages : [] })
  })

  it('does not collapse matching records separated by another raw record', async () => {
    const filePath = await writeFixture([
      eventMessage(TEXT),
      { type: 'event_msg', timestamp: EVENT_TIMESTAMP, payload: { type: 'token_count' } },
      responseMessage(TEXT)
    ])

    const result = await readNativeChatTranscript('codex', 'separated', { filePath })

    expect('messages' in result && result.messages.map(textOf)).toEqual([TEXT, TEXT])
  })

  it('keeps pagination on the older edge of a collapsed pair', async () => {
    const filePath = await writeFixture([
      eventMessage('older'),
      eventMessage(TEXT),
      responseMessage(TEXT),
      eventMessage('newer')
    ])
    const decode = nativeChatLineDecoderForAgent('codex')!

    const newest = await readNativeChatTranscriptTailFile(filePath, 2, decode, true)
    const older = await readNativeChatTranscriptTailFile(
      filePath,
      2,
      decode,
      true,
      newest.beforeOffset
    )

    expect(newest.messages.map(textOf)).toEqual([TEXT, 'newer'])
    expect(older.messages.map(textOf)).toEqual(['older'])
  })

  it('collapses a pair split between the initial tail and live append', async () => {
    const filePath = await writeFixture([eventMessage(TEXT)], true)
    const snapshots: string[][] = []
    const appends: string[] = []
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'split-pair',
      filePath,
      initialLimit: 10,
      onInitialSnapshot: (messages) => snapshots.push(messages.map(textOf)),
      onAppend: (messages) => appends.push(...messages.map(textOf)),
      debounceMs: 5
    })
    await waitFor(() => snapshots.length === 1)

    await appendFile(filePath, `${JSON.stringify(responseMessage(TEXT))}\n`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    subscription.unsubscribe()

    expect(snapshots).toEqual([[TEXT]])
    expect(appends).toEqual([])
  })

  it('seeds paginated mode before a watcher scans the transcript tail in reverse', async () => {
    const filePath = await writeFixture(
      [
        {
          type: 'session_meta',
          payload: { id: 'paginated-session', history_mode: 'paginated' }
        },
        responseMessage('model-only copy')
      ],
      true
    )
    const snapshots: string[][] = []
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'paginated-session',
      filePath,
      initialLimit: 10,
      onInitialSnapshot: (messages) => snapshots.push(messages.map(textOf)),
      onAppend: () => {},
      debounceMs: 5
    })
    await waitFor(() => snapshots.length === 1)
    subscription.unsubscribe()

    expect(snapshots).toEqual([[]])
  })
})
