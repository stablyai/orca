import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  readOpenCodeNativeChatTranscriptFull,
  readOpenCodeNativeChatTranscriptTail,
  resolveOpenCodeTranscriptDbPath,
  type OpenCodeTranscriptDeps
} from './transcript-opencode'
import { DESKTOP_READ_WINDOW } from './transcript-watch-contract'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('readOpenCodeNativeChatTranscriptFull', () => {
  const message = (id: string): NativeChatMessage => ({
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  })

  it('returns the whole session oldest-first across page boundaries', async () => {
    // Five messages served in windows of two: pages arrive newest-window-first
    // (each oldest-first); the full read must concatenate them globally
    // oldest-first like the JSONL full reader, not in page-fetch order.
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5']
    const readPage: OpenCodeTranscriptDeps['readPage'] = async (args) => {
      const upper = args.beforeMessageRowId ?? 6
      const lower = Math.max(1, upper - 2)
      const slice = ids.slice(lower - 1, upper - 1)
      return {
        items: slice.map((id, index) => ({
          rowid: lower + index,
          fingerprint: id,
          message: message(id)
        })),
        hasMore: lower > 1,
        beforeMessageRowId: lower > 1 ? lower : null
      }
    }
    const result = await readOpenCodeNativeChatTranscriptFull('ses-1', {
      resolveDbPath: async () => '/fake/opencode.db',
      readPage
    })
    expect(result).toEqual({ messages: ids.map(message) })
  })

  it('reports notFound when the first page misses', async () => {
    const readPage: OpenCodeTranscriptDeps['readPage'] = async () => null
    const result = await readOpenCodeNativeChatTranscriptFull('missing', {
      resolveDbPath: async () => '/fake/opencode.db',
      readPage
    })
    expect(result).toEqual({ error: 'Transcript unavailable', notFound: true })
  })

  it('returns a retryable error when DB discovery throws', async () => {
    const result = await readOpenCodeNativeChatTranscriptFull('ses-1', {
      resolveDbPath: async () => {
        throw new Error('EACCES')
      },
      readPage: async () => null
    })
    expect(result).toEqual({ error: 'EACCES' })
  })
})

describe('readOpenCodeNativeChatTranscriptTail', () => {
  const message = (id: string): NativeChatMessage => ({
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  })

  it('passes beforeOffset through, floors the limit, and returns the page shape', async () => {
    let seen: { limit: number; beforeMessageRowId?: number } | null = null
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10.9, beforeOffset: 42 },
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readPage: async (args) => {
          seen = args
          return {
            items: [{ rowid: 40, fingerprint: 'm1', message: message('m1') }],
            hasMore: true,
            beforeMessageRowId: 39
          }
        }
      }
    )
    expect(seen).toMatchObject({
      dbPath: '/fake/opencode.db',
      sessionId: 'ses-1',
      limit: 10,
      beforeMessageRowId: 42
    })
    expect(result).toEqual({ messages: [message('m1')], hasMore: true, beforeOffset: 39 })
  })

  it('defaults a non-positive limit to the desktop window and 0 beforeOffset', async () => {
    let seenLimit = 0
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 0 },
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readPage: async (args) => {
          seenLimit = args.limit
          return {
            items: [{ rowid: 7, fingerprint: 'm1', message: message('m1') }],
            hasMore: false,
            beforeMessageRowId: null
          }
        }
      }
    )
    expect(seenLimit).toBe(DESKTOP_READ_WINDOW)
    expect(result).toEqual({ messages: [message('m1')], hasMore: false, beforeOffset: 0 })
  })

  it('reports notFound when the page misses — the session row has not landed', async () => {
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10 },
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readPage: async () => null
      }
    )
    expect(result).toEqual({ error: 'Transcript unavailable', notFound: true })
  })

  it('reports notFound when no DB resolves', async () => {
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10 },
      { resolveDbPath: async () => null, readPage: async () => null }
    )
    expect(result).toEqual({ error: 'Transcript unavailable', notFound: true })
  })

  it('returns a retryable error without notFound when the page read throws', async () => {
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10 },
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readPage: async () => {
          throw new Error('worker timeout')
        }
      }
    )
    expect(result).toEqual({ error: 'worker timeout' })
  })

  it('returns a retryable error when DB discovery throws', async () => {
    // Discovery scans the filesystem and can throw (EACCES/EIO) — the
    // value-error contract must not leak that as a rejection.
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10 },
      {
        resolveDbPath: async () => {
          throw new Error('EACCES')
        },
        readPage: async () => null
      }
    )
    expect(result).toEqual({ error: 'EACCES' })
  })
})

describe('resolveOpenCodeTranscriptDbPath', () => {
  function createDataHome(): string {
    const dataHome = mkdtempSync(join(tmpdir(), 'orca-opencode-discover-'))
    tempDirs.push(dataHome)
    return dataHome
  }

  it('prefers the canonical opencode.db over stale opencode-*.db siblings', async () => {
    const dataHome = createDataHome()
    const dir = join(dataHome, 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode-backup.db'), '')
    writeFileSync(join(dir, 'opencode.db'), '')
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(join(dir, 'opencode.db'))
  })

  it('falls back to a sibling when no canonical DB exists', async () => {
    const dataHome = createDataHome()
    const dir = join(dataHome, 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode-backup.db'), '')
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(join(dir, 'opencode-backup.db'))
  })

  it('never falls back onto an OpenCode 2 (session_v2) DB', async () => {
    const dataHome = createDataHome()
    const dir = join(dataHome, 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode-local.db'), '')
    writeFileSync(join(dir, 'opencode-next.db'), '')
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    // Why: an OpenCode-2-only machine must report no DB (not-found), not
    // select a session_v2 DB the v1 queries cannot read.
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(null)
  })

  it('keeps the canonical v1 DB when OpenCode 2 DBs coexist', async () => {
    const dataHome = createDataHome()
    const dir = join(dataHome, 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode-next.db'), '')
    writeFileSync(join(dir, 'opencode-local.db'), '')
    writeFileSync(join(dir, 'opencode.db'), '')
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(join(dir, 'opencode.db'))
  })

  it('honors the OPENCODE_DB override and returns null with no DBs', async () => {
    const dataHome = createDataHome()
    const override = join(dataHome, 'custom.db')
    writeFileSync(override, '')
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    vi.stubEnv('OPENCODE_DB', override)
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(override)

    vi.stubEnv('OPENCODE_DB', '')
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(null)
  })
})
