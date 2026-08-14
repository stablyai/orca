import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type { SessionFileCandidate } from './session-scanner-types'

const STALLED_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\a.jsonl'
const SIBLING_PATH = '\\\\wsl.localhost\\Debian\\home\\ada\\.claude\\projects\\p\\b.jsonl'

const mocks = vi.hoisted(() => ({ open: vi.fn(), readdir: vi.fn() }))

// readdir too: every claude parse counts sibling subagent transcripts, and an
// unmocked one would reach the host UNC path and stall under fake timers.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  open: mocks.open,
  readdir: mocks.readdir
}))

import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import {
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS,
  WslTranscriptFsError
} from '../native-chat/wsl-transcript-fs-gate'

type ReadResult = { bytesRead: number; buffer: Buffer }

// A stalled task keeps the gate's single scan slot until the call settles, so
// every case releases its stall before the next one runs.
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

async function releaseAndSettle(): Promise<void> {
  releaseStall?.()
  releaseStall = undefined
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  resetSessionParseCacheForTests()
  mocks.open.mockReset()
  mocks.readdir.mockReset()
  mocks.readdir.mockResolvedValue([])
  releaseStall = undefined
  vi.useFakeTimers()
})

afterEach(async () => {
  await releaseAndSettle()
  vi.useRealTimers()
})

describe('AI Vault session parse with a stalled WSL transcript body read', () => {
  it('refuses the stalled candidate and still parses a sibling on a healthy distro', async () => {
    mocks.open.mockResolvedValue({ read: vi.fn(stalls), close: vi.fn(async () => {}) })
    // Rejecting (not resolving null) is what lets `parseSessionCandidate`
    // report it as an issue instead of silently dropping the session. The
    // assertion is attached before the clock moves so the rejection is never
    // momentarily unhandled.
    const refusal = expect(
      parseAgentSessionFileCached(candidate(STALLED_PATH, body(2), 1), 'linux')
    ).rejects.toBeInstanceOf(WslTranscriptFsError)
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS + 1)
    await refusal

    await releaseAndSettle()
    const siblingBytes = body(2)
    mocks.open.mockResolvedValue(servingHandle(siblingBytes))

    const sibling = await parseAgentSessionFileCached(
      candidate(SIBLING_PATH, siblingBytes, 1),
      'linux'
    )
    expect(sibling?.messageCount).toBe(2)
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
