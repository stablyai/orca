import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { formatWorkerTranscriptMessage } from '../../../shared/native-chat/transcript/worker-transcript-text'
import { projectSavedChatContextItems } from './agent-session-saved-prompt-text'
import { ContinuedTranscriptMarkers, continuedFileText } from './agent-session-continued-transcript'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

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

/** The snapshot text when `stored` (SQLite's bytes) stands in for an excerpt, and the plain one for `whole`. */
async function both(stored: Buffer, whole: string) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-continued-'))
  dirs.push(dir)
  const path = join(dir, 'whole.spill')
  writeFileSync(path, stored)
  const markers = new ContinuedTranscriptMarkers()
  const marked = projectSavedChatContextItems([markers.mark(tool('start … end'), 0)])
  const parts: string[] = []
  for await (const part of markers.transcript(
    marked.map(formatWorkerTranscriptMessage),
    (_, trim) => continuedFileText(path, trim)
  )) {
    parts.push(part)
  }
  const plain = projectSavedChatContextItems([tool(whole)]).map(formatWorkerTranscriptMessage)
  return {
    streamed: Buffer.from(parts.join('')),
    plain: Buffer.from(plain.join('\n\n')),
    marked,
    markers
  }
}

it('streams the whole stored text in place of its excerpt, byte for byte as the plain transcript', async () => {
  // SQLite returns a lone surrogate as three bytes; put them across the 1 MiB read boundary.
  const lead = 'a'.repeat(1024 * 1024 - 1)
  const tail = ` 😀 done${' '.repeat(2 * 1024 * 1024)}\n\t`
  const stored = Buffer.concat([
    Buffer.from(lead),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from(tail)
  ])
  const { streamed, plain, marked, markers } = await both(stored, `${lead}\uD800${tail}`)
  expect(streamed.equals(plain)).toBe(true)
  expect(markers.excerpts(marked)[0].blocks.at(-1)).toMatchObject({ output: 'start … end' })
})

it('trims a blank whole text into the line before it, as the plain transcript does', async () => {
  const blank = ' \n'.repeat(40_000)
  const { streamed, plain } = await both(Buffer.from(blank), blank)
  expect(streamed.equals(plain)).toBe(true)
})
