// One transcript line can decode into SEVERAL messages — omp splits a mixed
// thinking+reply turn into a reasoning message ahead of the assistant one
// (transcript-line-decoders-omp.ts). Both worker-transcript readers must spread
// that result in decoded order rather than dropping or nesting it.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IFilesystemProvider } from '../../providers/types'
import { readWorkerTranscript } from './worker-transcript-read'

/** A mixed thinking+reply omp turn: one line, two decoded messages. */
function ompSplitTurn(id: string, thinking: string, reply: string): string {
  return JSON.stringify({
    type: 'message',
    id,
    timestamp: '2026-07-16T00:27:02.222Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking },
        { type: 'text', text: reply }
      ]
    }
  })
}

function roleAndText(messages: readonly { role: string; blocks: readonly unknown[] }[]): string[] {
  return messages.map((message) => {
    const block = message.blocks[0] as { text?: string } | undefined
    return `${message.role}:${block?.text ?? ''}`
  })
}

describe('a decoder that returns several messages for one line', () => {
  let directory: string
  let transcriptPath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-omp-multi-decode-'))
    transcriptPath = join(directory, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps both messages, reasoning first, on the local initial read', async () => {
    await writeFile(transcriptPath, `${ompSplitTurn('rec-1', 'Weighing it', 'Done')}\n`)

    const page = await readWorkerTranscript({ agent: 'omp', sessionId: 's', transcriptPath })

    if (!page.ok) {
      throw new Error(`expected a transcript page, got ${page.reason}`)
    }
    expect(roleAndText(page.messages)).toEqual(['reasoning:Weighing it', 'assistant:Done'])
  })

  it('keeps both messages, reasoning first, on the local forward read', async () => {
    await writeFile(transcriptPath, `${ompSplitTurn('rec-1', 'Weighing it', 'Done')}\n`)

    const page = await readWorkerTranscript({
      agent: 'omp',
      sessionId: 's',
      transcriptPath,
      offset: 0
    })

    if (!page.ok) {
      throw new Error(`expected a transcript page, got ${page.reason}`)
    }
    expect(roleAndText(page.messages)).toEqual(['reasoning:Weighing it', 'assistant:Done'])
  })

  it('keeps every message of a split line the initial read admits', async () => {
    await writeFile(
      transcriptPath,
      `${ompSplitTurn('rec-1', 'First think', 'First reply')}\n${ompSplitTurn('rec-2', 'Second think', 'Second reply')}\n`
    )

    // `limit` counts messages, and one line yields two, so the newest line
    // arrives whole rather than as a lone half of a decoded turn.
    const page = await readWorkerTranscript({
      agent: 'omp',
      sessionId: 's',
      transcriptPath,
      limit: 2
    })

    if (!page.ok) {
      throw new Error(`expected a transcript page, got ${page.reason}`)
    }
    expect(roleAndText(page.messages)).toEqual(['reasoning:Second think', 'assistant:Second reply'])
  })

  it('keeps both messages, reasoning first, on the remote read', async () => {
    const contents = `${ompSplitTurn('rec-1', 'Weighing it', 'Done')}\n`
    // No `readFileRange`, so this takes the bounded legacy-snapshot window.
    const filesystemProvider = {
      stat: async () => ({
        type: 'file',
        size: Buffer.byteLength(contents),
        mtimeMs: 1,
        ino: 7,
        dev: 3
      }),
      readFile: async () => ({ content: contents })
    } as unknown as IFilesystemProvider

    const page = await readWorkerTranscript({
      agent: 'omp',
      sessionId: 's',
      transcriptPath: '/remote/session.jsonl',
      filesystemProvider
    })

    if (!page.ok) {
      throw new Error(`expected a transcript page, got ${page.reason}`)
    }
    expect(roleAndText(page.messages)).toEqual(['reasoning:Weighing it', 'assistant:Done'])
  })
})
