import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const CODEX_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex'
const CODEX_SESSION_FILE = `${CODEX_HOME}\\sessions\\2026\\01\\01\\rollout-1.jsonl`
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const KIMI_INDEX = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.kimi\\session_index.jsonl'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), open: vi.fn(), readFile: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  stat: mocks.stat,
  open: mocks.open,
  readFile: mocks.readFile
}))

import {
  readCodexSessionIndexTitle,
  resetCodexSessionIndexTitleCacheForTests,
  _hasCodexSessionIndexTitleCacheEntryForTest
} from './session-scanner-codex-title-index'
import {
  clearKimiSessionIndexCache,
  hasKimiSessionIndexCacheEntryForTests,
  readKimiWorkDirBySessionId
} from './session-scanner-kimi-paths'
import { readJsonObjectIfExists } from './session-scanner-values'
import {
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS,
  WslTranscriptFsError
} from '../native-chat/wsl-transcript-fs-gate'

// Identity must not change between the refused and the recovered read, or the
// cache would miss for that reason instead of because the entry was evicted.
const INDEX_STATS = { size: 128, mtimeMs: 7, ctimeMs: 7 }

let releaseStall: (() => void) | undefined

function stalls(): Promise<never> {
  return new Promise<never>((resolve) => {
    releaseStall = () => resolve(undefined as never)
  })
}

function servingHandle(body: string) {
  const bytes = Buffer.from(body)
  return {
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const slice = bytes.subarray(position, Math.min(position + length, bytes.length))
      slice.copy(buffer, offset)
      return { bytesRead: slice.length, buffer }
    }),
    close: vi.fn(async () => {})
  }
}

async function releaseAndSettle(): Promise<void> {
  releaseStall?.()
  releaseStall = undefined
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  resetCodexSessionIndexTitleCacheForTests()
  clearKimiSessionIndexCache()
  mocks.stat.mockReset()
  mocks.open.mockReset()
  mocks.readFile.mockReset()
  mocks.stat.mockResolvedValue(INDEX_STATS)
  releaseStall = undefined
  vi.useFakeTimers()
})

afterEach(async () => {
  await releaseAndSettle()
  vi.useRealTimers()
})

describe('memoized WSL session indexes under a stalled mount', () => {
  it('evicts the Codex title index instead of pinning "no titles"', async () => {
    mocks.open.mockResolvedValue({ read: vi.fn(stalls), close: vi.fn(async () => {}) })
    const refused = readCodexSessionIndexTitle(CODEX_SESSION_FILE, CODEX_HOME, SESSION_ID)
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS + 1)

    expect(await refused).toBeNull()
    expect(_hasCodexSessionIndexTitleCacheEntryForTest(CODEX_HOME)).toBe(false)

    await releaseAndSettle()
    mocks.open.mockResolvedValue(
      servingHandle(`${JSON.stringify({ id: SESSION_ID, thread_name: 'Ship the gate' })}\n`)
    )

    // Same size/mtime as the refused read: only the eviction can produce a hit.
    expect(await readCodexSessionIndexTitle(CODEX_SESSION_FILE, CODEX_HOME, SESSION_ID)).toBe(
      'Ship the gate'
    )
  })

  it('evicts the Kimi work-dir index instead of pinning "no cwd"', async () => {
    mocks.open.mockResolvedValue({ read: vi.fn(stalls), close: vi.fn(async () => {}) })
    const refused = readKimiWorkDirBySessionId(KIMI_INDEX)
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS + 1)

    expect(await refused).toEqual(new Map())
    expect(hasKimiSessionIndexCacheEntryForTests(KIMI_INDEX)).toBe(false)

    await releaseAndSettle()
    mocks.open.mockResolvedValue(
      servingHandle(`${JSON.stringify({ sessionId: SESSION_ID, workDir: '/repo/app' })}\n`)
    )

    expect(await readKimiWorkDirBySessionId(KIMI_INDEX)).toEqual(
      new Map([[SESSION_ID, '/repo/app']])
    )
  })

  it('surfaces a refused optional JSON enrichment instead of caching it as absent', async () => {
    mocks.readFile.mockImplementation(stalls)
    const pending = readJsonObjectIfExists(`${CODEX_HOME}\\history.json`).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS + 1)

    // A throw, not `null`: `parseSessionCandidate` turns it into a scan issue,
    // where `null` would cache an un-enriched session that never re-reads.
    expect(await pending).toBeInstanceOf(WslTranscriptFsError)
  })

  it('still degrades a missing optional JSON file to null', async () => {
    mocks.readFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' as const })
    )
    await expect(readJsonObjectIfExists(`${CODEX_HOME}\\missing.json`)).resolves.toBeNull()
  })
})
