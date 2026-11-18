import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { formatWorkerTranscriptMessage } from '../../../shared/native-chat/transcript/worker-transcript-text'
import { projectSavedChatContextItems } from './agent-session-saved-prompt-text'
import { ContinuedTranscriptMarkers, decodeStoredText } from './agent-session-continued-transcript'

const tool = (head: string): AgentJournalRenderItem => ({
  itemId: 'tool',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'tool-call',
    name: 'Bash',
    input: {},
    state: 'completed',
    output: { head, byteLength: 0, digest: 'd', truncated: false }
  }
})

async function* chunks(...parts: Buffer[]): AsyncGenerator<Uint8Array> {
  yield* parts
}

it('streams the whole stored text in place of its excerpt, as the plain transcript prints it', async () => {
  const whole = 'run 😀 \uD800 done  \n\t'
  // SQLite returns the lone surrogate as three bytes; split it and the emoji across chunks.
  const stored = Buffer.concat([
    Buffer.from('run 😀 ', 'utf8'),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from(' done  \n\t', 'utf8')
  ])
  const markers = new ContinuedTranscriptMarkers()
  const marked = projectSavedChatContextItems([markers.mark(tool('run … done'), 0)])
  const parts: string[] = []
  for await (const part of markers.transcript(marked.map(formatWorkerTranscriptMessage), () =>
    decodeStoredText(
      chunks(
        stored.subarray(0, 6),
        stored.subarray(6, 10),
        stored.subarray(10, 11),
        stored.subarray(11)
      )
    )
  )) {
    parts.push(part)
  }

  const plain = projectSavedChatContextItems([tool(whole)]).map(formatWorkerTranscriptMessage)
  expect(Buffer.from(parts.join(''), 'utf8')).toEqual(Buffer.from(plain.join('\n\n'), 'utf8'))
  expect(markers.excerpts(marked)[0].blocks.at(-1)).toMatchObject({ output: 'run … done' })
})

it('trims a blank whole text into the line before it, as the plain transcript does', async () => {
  const markers = new ContinuedTranscriptMarkers()
  const marked = projectSavedChatContextItems([markers.mark(tool(' \n'), 0)])
  const parts: string[] = []
  for await (const part of markers.transcript(marked.map(formatWorkerTranscriptMessage), () =>
    decodeStoredText(chunks(Buffer.from(' \n'.repeat(40_000))))
  )) {
    parts.push(part)
  }
  const plain = projectSavedChatContextItems([tool(' \n'.repeat(40_000))])
  expect(parts.join('')).toBe(plain.map(formatWorkerTranscriptMessage).join('\n\n'))
})
