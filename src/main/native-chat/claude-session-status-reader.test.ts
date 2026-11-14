import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClaudeSessionStatusReader,
  MAX_CLAUDE_SESSION_STATUS_LINE_BYTES
} from './claude-session-status-reader'

const reply = (cacheRead: number): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
        output_tokens: 1
      }
    }
  })

const COMPACT = JSON.stringify({ type: 'system', subtype: 'compact_boundary' })

describe('createClaudeSessionStatusReader', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-session-status-'))
    file = join(dir, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null for a missing file', async () => {
    await expect(createClaudeSessionStatusReader().read(file)).resolves.toBeNull()
  })

  it('picks up what was appended since the last read', async () => {
    const reader = createClaudeSessionStatusReader()
    await writeFile(file, `${reply(100)}\n${reply(200)}\n`)
    expect(await reader.read(file)).toMatchObject({ usedTokens: 200 })
    await appendFile(file, `${reply(300)}\n`)
    expect(await reader.read(file)).toMatchObject({ usedTokens: 300 })
  })

  it('counts a line once when it arrives in two writes', async () => {
    const reader = createClaudeSessionStatusReader()
    await writeFile(file, COMPACT.slice(0, 10))
    expect(await reader.read(file)).toMatchObject({ compactions: 0 })
    await appendFile(file, `${COMPACT.slice(10)}\n`)
    expect(await reader.read(file)).toMatchObject({ compactions: 1 })
    expect(await reader.read(file)).toMatchObject({ compactions: 1 })
  })

  it('counts a line once when reads overlap', async () => {
    const reader = createClaudeSessionStatusReader()
    await writeFile(file, `${COMPACT}\n${COMPACT}\n`)
    const results = await Promise.all([reader.read(file), reader.read(file), reader.read(file)])
    expect(results.map((facts) => facts?.compactions)).toEqual([2, 2, 2])
  })

  it('counts from zero again when the file shrinks', async () => {
    const reader = createClaudeSessionStatusReader()
    await writeFile(file, `${COMPACT}\n${COMPACT}\n${COMPACT}\n`)
    expect(await reader.read(file)).toMatchObject({ compactions: 3 })
    await writeFile(file, `${COMPACT}\n`)
    expect(await reader.read(file)).toMatchObject({ compactions: 1 })
  })

  it('reads a file replaced at the same path from the start', async () => {
    const reader = createClaudeSessionStatusReader()
    await writeFile(file, `${COMPACT}\n${COMPACT}\n${COMPACT}\n`)
    expect(await reader.read(file)).toMatchObject({ compactions: 3 })
    const replacement = join(dir, 'replacement.jsonl')
    await writeFile(replacement, `${reply(500)}\n${reply(500)}\n`)
    await rename(replacement, file)
    expect(await reader.read(file)).toMatchObject({ compactions: 0, usedTokens: 500 })
  })

  it('forgets a file that disappeared', async () => {
    const reader = createClaudeSessionStatusReader()
    await writeFile(file, `${COMPACT}\n`)
    expect(await reader.read(file)).toMatchObject({ compactions: 1 })
    await rm(file)
    await expect(reader.read(file)).resolves.toBeNull()
  })

  it('skips an oversized record and keeps reading the rows after it', async () => {
    const reader = createClaudeSessionStatusReader()
    const huge = `"assistant"${'x'.repeat(MAX_CLAUDE_SESSION_STATUS_LINE_BYTES + 1)}`
    await writeFile(file, `${huge}\n${reply(700)}\n`)
    expect(await reader.read(file)).toMatchObject({ usedTokens: 700 })
  })

  it('does not hand out state that a later read changes', async () => {
    const reader = createClaudeSessionStatusReader()
    await writeFile(file, `${COMPACT}\n`)
    const first = await reader.read(file)
    await appendFile(file, `${COMPACT}\n`)
    await reader.read(file)
    expect(first?.compactions).toBe(1)
  })
})
