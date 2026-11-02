import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseHermesSessionFile } from './session-scanner-hermes-parser'
import { parseDevinSessionFile } from './session-scanner-devin-parser'
import { parseGeminiSessionFile } from './session-scanner-gemini-parsers'
import { parseClineSessionFile } from './session-scanner-cline-parser'

const providers = [
  { agent: 'hermes', parse: parseHermesSessionFile, array: 'messages' },
  { agent: 'devin', parse: parseDevinSessionFile, array: 'steps' },
  { agent: 'gemini', parse: parseGeminiSessionFile, array: 'messages' },
  { agent: 'cline', parse: parseClineSessionFile, array: 'messages' }
] as const

function collectHeap(): number {
  if (!globalThis.gc) {
    throw new Error('Run this regression with --expose-gc')
  }
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

async function writeLongDocument(
  path: string,
  messages: number,
  agent: string,
  array: string
): Promise<void> {
  const file = await open(path, 'wx')
  try {
    await file.writeFile(`{"session_id":"long-session","${array}":[`)
    for (let start = 0; start < messages; start += 128) {
      const batch = Array.from({ length: Math.min(128, messages - start) }, (_, offset) => {
        const index = start + offset
        return `${index === 0 ? '' : ','}${JSON.stringify({
          role: index === 0 ? 'user' : 'assistant',
          type: index === 0 ? 'user' : 'gemini',
          source: index === 0 ? 'user' : 'agent',
          model: 'model-at-end',
          message: agent === 'devin' ? `${index}:${'body'.repeat(1024)}` : undefined,
          content: `${index}:${'body'.repeat(1024)}`
        })}`
      }).join('')
      await file.writeFile(batch)
    }
    await file.writeFile(
      '],"model":"model-at-end","agent":{"model_name":"model-at-end"},"cwd":"/workspace/project"}'
    )
  } finally {
    await file.close()
  }
}

it.each(providers)(
  'folds a large local $agent document without retaining all decoded messages',
  async ({ agent, parse, array }) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-json-document-memory-'))
    try {
      const path = join(root, 'session.json')
      const messageCount = 8192
      const contentPath = agent === 'cline' ? join(root, 'session.messages.json') : path
      if (agent === 'cline') {
        await writeFile(path, JSON.stringify({ session_id: 'long-session', model: 'model-at-end' }))
      }
      await writeLongDocument(contentPath, messageCount, agent, array)
      const baseline = collectHeap()
      let firstMessageRetainedBytes = 0
      let emitted = 0
      let lastText = ''
      const session = await parse(
        { path, mtimeMs: 1, modifiedAt: '2026-10-19T00:00:00.000Z' },
        'linux',
        {
          active: true,
          push(message) {
            if (emitted === 0) {
              firstMessageRetainedBytes = collectHeap() - baseline
            }
            emitted++
            lastText = message.text
          }
        }
      )
      expect(emitted).toBe(messageCount)
      expect(lastText).toBe(`${messageCount - 1}:${'body'.repeat(1024)}`)
      expect(session?.messageCount).toBe(messageCount)
      expect(session?.model).toBe('model-at-end')
      expect(firstMessageRetainedBytes).toBeLessThan(8 * 1024 * 1024)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(providers)(
  'cancels a streamed local $agent document before consuming the whole file',
  async ({ agent, parse, array }) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-json-document-cancel-'))
    try {
      const path = join(root, 'session.json')
      const contentPath = agent === 'cline' ? join(root, 'session.messages.json') : path
      if (agent === 'cline') {
        await writeFile(path, '{"session_id":"session"}')
      }
      await writeLongDocument(contentPath, 1024, agent, array)
      const controller = new AbortController()
      let emitted = 0
      await expect(
        parse(
          { path, mtimeMs: 1, modifiedAt: new Date(1).toISOString() },
          'linux',
          {
            active: true,
            push: () => {
              emitted++
              controller.abort()
            }
          },
          controller.signal
        )
      ).rejects.toThrow(/cancel/i)
      expect(emitted).toBeGreaterThan(0)
      expect(emitted).toBeLessThan(1024)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
