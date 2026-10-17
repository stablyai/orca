import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeptAgentConversations, type KeptConversation } from './kept-agent-conversations'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

let dir: string
let filePath: string

function entry(overrides: Partial<KeptConversation> = {}): KeptConversation {
  return { lane: 'host', accountId: 'acc-a', keptAt: NOW, ...overrides }
}

function open(): KeptAgentConversations {
  return new KeptAgentConversations({ filePath, now: () => NOW })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-kept-conversations-'))
  filePath = join(dir, 'agent-kept-conversations.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('KeptAgentConversations', () => {
  it('creates no file until the first keep, then survives a reload', () => {
    const index = open()
    expect(index.get('claude', 's1')).toBeNull()
    expect(existsSync(filePath)).toBe(false)

    index.keep('claude', 's1', entry({ transcriptPath: '/t/s1.jsonl' }))
    index.keep('codex', 's2', entry({ accountId: null }))

    const reloaded = open()
    expect(reloaded.get('claude', 's1')).toEqual(entry({ transcriptPath: '/t/s1.jsonl' }))
    expect(reloaded.get('codex', 's2')).toEqual(entry({ accountId: null }))
    expect(reloaded.get('codex', 's1')).toBeNull()
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('releases one conversation, or every conversation kept on a removed account', () => {
    const index = open()
    index.keep('claude', 's1', entry())
    index.keep('claude', 's2', entry())
    index.keep('claude', 's3', entry({ accountId: 'acc-b' }))
    index.keep('codex', 's4', entry())

    index.release('claude', 's1')
    expect(index.releaseAccount('claude', 'acc-a')).toBe(1)

    const reloaded = open()
    expect(reloaded.get('claude', 's2')).toBeNull()
    expect(reloaded.get('claude', 's3')).toEqual(entry({ accountId: 'acc-b' }))
    expect(reloaded.get('codex', 's4')).toEqual(entry())
  })

  it('un-keeping any session of an agent releases every session that carried its keep', () => {
    const index = open()
    index.keep('codex', 'c1', entry())
    index.keep('codex', 'c2', entry({ keptVia: 'codex:c1' }))
    index.keep('codex', 'c3', entry({ keptVia: 'codex:c1' }))
    index.keep('codex', 'other', entry())

    index.release('codex', 'c3')

    const reloaded = open()
    expect(reloaded.get('codex', 'c1')).toBeNull()
    expect(reloaded.get('codex', 'c2')).toBeNull()
    expect(reloaded.get('codex', 'c3')).toBeNull()
    expect(reloaded.get('codex', 'other')).toEqual(entry())
  })

  it('drops one carried keep only while it is the one that was carried', () => {
    const index = open()
    index.keep('claude', 's2', entry({ keptAt: 5, keptVia: 'claude:s1' }))
    index.releaseCarried('claude', 's2', 4)
    expect(index.get('claude', 's2')).toEqual(entry({ keptAt: 5, keptVia: 'claude:s1' }))

    index.releaseCarried('claude', 's2', 5)
    expect(open().get('claude', 's2')).toBeNull()
  })

  it('reads back where a keep was carried from, and ignores a malformed origin', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        conversations: {
          'claude:s2': entry({ keptVia: 'claude:s1' }),
          'claude:s3': { ...entry(), keptVia: 'not a key' }
        }
      })
    )
    const index = open()
    expect(index.get('claude', 's2')).toEqual(entry({ keptVia: 'claude:s1' }))
    expect(index.get('claude', 's3')).toEqual(entry())
  })

  it('reads a newer version as nothing kept, and never rewrites it', () => {
    const newer = JSON.stringify({ version: 2, conversations: { 'claude:s1': entry() } })
    writeFileSync(filePath, newer)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = open()

    // Nothing is refused: conversations follow the selection as before anything was kept.
    expect(index.get('claude', 's1')).toBeNull()
    expect(index.acceptsChanges()).toBe(false)
    index.keep('claude', 's2', entry())
    index.release('claude', 's1')

    expect(readFileSync(filePath, 'utf-8')).toBe(newer)
    expect(readdirSync(dir)).toEqual(['agent-kept-conversations.json'])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('reports an unreadable file as unavailable, uncached, and merges a queued keep later', async () => {
    vi.useFakeTimers()
    const seed = open()
    seed.keep('claude', 'earlier', entry())
    const persisted = readFileSync(filePath, 'utf-8')
    rmSync(filePath)
    // Why: a directory in the file's place fails the read with EISDIR, not absence.
    mkdirSync(filePath)

    const index = open()
    expect(index.get('claude', 'earlier')).toBe('unavailable')
    index.keep('claude', 'queued', entry({ accountId: 'acc-b' }))
    expect(statSync(filePath).isDirectory()).toBe(true)

    rmSync(filePath, { recursive: true })
    writeFileSync(filePath, persisted)
    expect(index.get('claude', 'earlier')).toEqual(entry())
    await vi.advanceTimersByTimeAsync(100)

    const reloaded = open()
    expect(reloaded.get('claude', 'earlier')).toEqual(entry())
    expect(reloaded.get('claude', 'queued')).toEqual(entry({ accountId: 'acc-b' }))
  })

  it('shows a keep and a release queued while the file was unreadable to the first read after', () => {
    vi.useFakeTimers()
    const seed = open()
    seed.keep('claude', 'earlier', entry())
    const persisted = readFileSync(filePath, 'utf-8')
    rmSync(filePath)
    mkdirSync(filePath)

    const index = open()
    expect(index.get('claude', 'earlier')).toBe('unavailable')
    index.keep('claude', 'queued', entry({ accountId: 'acc-b' }))
    index.release('claude', 'earlier')

    rmSync(filePath, { recursive: true })
    writeFileSync(filePath, persisted)
    // Why no timer advance: the retry has not fired, so only this read can apply the queue.
    expect(index.get('claude', 'queued')).toEqual(entry({ accountId: 'acc-b' }))
    expect(index.get('claude', 'earlier')).toBeNull()
  })

  it('persists a mutation queued past every retry once a read finds the file readable', async () => {
    vi.useFakeTimers()
    mkdirSync(filePath)

    const index = open()
    index.keep('claude', 'queued', entry())
    await vi.advanceTimersByTimeAsync(100 + 1_000 + 5_000 + 30_000)
    rmSync(filePath, { recursive: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(existsSync(filePath)).toBe(false)

    expect(index.get('claude', 'queued')).toEqual(entry())
    expect(open().get('claude', 'queued')).toEqual(entry())
  })

  it('sets a corrupt file aside and starts empty', () => {
    writeFileSync(filePath, '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(open().get('claude', 's1')).toBeNull()

    expect(readdirSync(dir).some((name) => name.includes('.corrupt-'))).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('drops malformed entries and keeps their valid siblings', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        conversations: {
          'claude:good': entry(),
          'claude:bad-id': { ...entry(), accountId: '../x' },
          'claude:bad-lane': { ...entry(), lane: 'Ubuntu' },
          'gemini:other': entry()
        }
      })
    )
    const index = open()
    expect(index.get('claude', 'good')).toEqual(entry())
    expect(index.get('claude', 'bad-id')).toBeNull()
    expect(index.get('claude', 'bad-lane')).toBeNull()
  })

  it('keeps every kept conversation, however many there are', () => {
    const index = open()
    for (let n = 0; n < 5_000; n += 1) {
      index.keep('codex', `s${n}`, entry({ keptAt: n }))
    }
    const reloaded = open()
    expect(reloaded.get('codex', 's0')).toEqual(entry({ keptAt: 0 }))
    expect(reloaded.get('codex', 's4999')).toEqual(entry({ keptAt: 4999 }))
  })

  it('prunes only old keeps whose transcript is definitively gone', async () => {
    const live = join(dir, 'live.jsonl')
    writeFileSync(live, '')
    const loop = join(dir, 'loop.jsonl')
    // Why: a self-referencing link fails stat with ELOOP, which is not proof of absence.
    symlinkSync(loop, loop)
    const old = NOW - 8 * DAY_MS
    const index = open()
    index.keep('claude', 'gone-old', entry({ keptAt: old, transcriptPath: join(dir, 'gone') }))
    index.keep(
      'claude',
      'gone-new',
      entry({ keptAt: NOW - DAY_MS, transcriptPath: join(dir, 'x') })
    )
    index.keep('claude', 'live-old', entry({ keptAt: old, transcriptPath: live }))
    index.keep('claude', 'loop-old', entry({ keptAt: old, transcriptPath: loop }))
    index.keep('codex', 'no-path', entry({ keptAt: old }))

    await index.pruneUnreachable()

    const reloaded = open()
    expect(reloaded.get('claude', 'gone-old')).toBeNull()
    expect(reloaded.get('claude', 'gone-new')).not.toBeNull()
    expect(reloaded.get('claude', 'live-old')).not.toBeNull()
    expect(reloaded.get('claude', 'loop-old')).not.toBeNull()
    expect(reloaded.get('codex', 'no-path')).not.toBeNull()
  })
})
