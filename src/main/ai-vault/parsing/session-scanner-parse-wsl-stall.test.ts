import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statSync } from 'node:fs'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type { SessionFileCandidate } from '../session-scanner-types'

const STALLED_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\a.jsonl'

const mocks = vi.hoisted(() => ({ open: vi.fn(), readdir: vi.fn() }))

// Claude also counts sibling subagents; mock readdir to avoid real UNC access under fake timers.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  open: mocks.open,
  readdir: mocks.readdir
}))

import * as transcriptFs from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { parseAgentSessionFileCached } from '../parse-cache/session-scanner-parse-cache'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests
} from '../transcripts/session-transcript-consumers'
import { resetSessionParseCacheForTests } from '../parse-cache/session-parse-cache-store'
import {
  resetWslTranscriptFsGateForTests,
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS
} from '../../native-chat/transcript-filesystem/wsl-transcript-fs-gate'
import { WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS } from '../../native-chat/transcript-filesystem/wsl-transcript-fs-route-quarantine'
import { WslTranscriptFsError } from '../../native-chat/transcript-filesystem/wsl-transcript-fs-error'

type ReadResult = { bytesRead: number; buffer: Buffer }

// Settle stalled calls between cases to release their scan permits.
let releaseStall: (() => void) | undefined

function stalls(): Promise<ReadResult> {
  return new Promise<ReadResult>((resolve) => {
    releaseStall = () => resolve({ bytesRead: 0, buffer: Buffer.alloc(0) })
  })
}

function servingHandle(body: Buffer) {
  return {
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const slice = body.subarray(position, Math.min(position + length, body.length))
      slice.copy(buffer, offset)
      return { bytesRead: slice.length, buffer }
    }),
    close: vi.fn(async () => {})
  }
}

function record(index: number, text: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: new Date(1740000000000 + index * 60_000).toISOString(),
    cwd: '/repo/app',
    gitBranch: 'main',
    message: { role: 'user', content: text }
  })
}

function body(count: number): Buffer {
  return Buffer.from(
    Array.from({ length: count }, (_, index) => `${record(index, `line ${index}`)}\n`).join('')
  )
}

function candidate(path: string, bytes: Buffer, mtimeMs: number): SessionFileCandidate {
  return {
    agent: 'claude',
    file: {
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString(),
      sizeBytes: bytes.length
    },
    codexHome: null
  }
}

// Late results cannot clear quarantine; advance through backoff before retrying.
async function releaseAndSettle(): Promise<void> {
  releaseStall?.()
  releaseStall = undefined
  await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
}

beforeEach(() => {
  resetWslTranscriptFsGateForTests()
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  mocks.open.mockReset()
  mocks.readdir.mockReset()
  mocks.readdir.mockResolvedValue([])
  releaseStall = undefined
  // performance.now drives the route quarantine clock, so it must be faked too.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
})

afterEach(async () => {
  await releaseAndSettle()
  resetTranscriptConsumersForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('AI Vault session parse with a stalled WSL transcript body read', () => {
  it('cancels stalled EOF finalization, cleans up, and admits the next read', async () => {
    const bytes = body(2)
    const file = candidate(STALLED_PATH.replace('a.jsonl', 'finalization.jsonl'), bytes, 1)
    mocks.open.mockResolvedValue(servingHandle(bytes))
    let entered!: () => void
    const finalizing = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.spyOn(transcriptFs, 'wslGatedStat').mockResolvedValue(
      Object.assign(statSync(process.cwd()), {
        dev: 1,
        ino: 1,
        birthtimeMs: 1,
        mtimeMs: 1,
        ctimeMs: 1
      })
    )
    const readdir = vi.spyOn(transcriptFs, 'wslGatedReaddir').mockImplementationOnce(() => {
      entered()
      return new Promise(() => {})
    })
    const finishes = vi.fn()
    registerTranscriptConsumer({
      beginRead: () => ({ message: () => {}, finish: finishes })
    })
    const controller = new AbortController()
    const first = parseAgentSessionFileCached(
      file,
      'linux',
      undefined,
      undefined,
      controller.signal
    )
    const cancelled = first.catch((error) => {
      expect(error).toMatchObject({
        name: 'AbortError',
        message: 'Agent Session History scan was cancelled'
      })
      return 'cancelled'
    })
    await finalizing
    let nextMessageCount: number | undefined
    const next = parseAgentSessionFileCached(file, 'linux').then((session) => {
      nextMessageCount = session?.messageCount
      return session
    })
    let result: string | undefined
    void cancelled.then((value) => {
      result = typeof value === 'string' ? value : 'completed'
    })
    controller.abort()
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toBe('cancelled')
    expect(finishes).toHaveBeenNthCalledWith(1, expect.objectContaining({ cancelled: true }))
    expect(nextMessageCount).toBe(2)
    await next
    expect(finishes).toHaveBeenCalledTimes(2)
    readdir.mockRestore()
  })

  it('caches no resume point when the newline probe is refused mid-append', async () => {
    const first = body(2)
    mocks.open.mockResolvedValue(servingHandle(first))
    const seeded = await parseAgentSessionFileCached(candidate(STALLED_PATH, first, 1), 'linux')
    expect(seeded?.messageCount).toBe(2)

    const grown = body(3)
    const serving = servingHandle(grown)
    mocks.open.mockResolvedValue({
      // Only the 1-byte resume probe stalls; the body read stays healthy.
      read: vi.fn((buffer: Buffer, offset: number, length: number, position: number) =>
        length === 1 ? stalls() : serving.read(buffer, offset, length, position)
      ),
      close: vi.fn(async () => {})
    })
    const refused = expect(
      parseAgentSessionFileCached(candidate(STALLED_PATH, grown, 2), 'linux')
    ).rejects.toBeInstanceOf(WslTranscriptFsError)
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS + 1)
    await refused

    await releaseAndSettle()
    mocks.open.mockResolvedValue(servingHandle(grown))
    const recovered = await parseAgentSessionFileCached(candidate(STALLED_PATH, grown, 2), 'linux')

    resetSessionParseCacheForTests()
    const cold = await parseAgentSessionFileCached(candidate(STALLED_PATH, grown, 2), 'linux')
    expect(recovered).toEqual(cold)
    expect(recovered?.messageCount).toBe(3)
  })
})
