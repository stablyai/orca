import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { listLocalAiVaultSubagentSessions } from '../session-subagent-reader'
import { noteAiVaultScanWorkChanged } from '../ai-vault-scan-progress'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'

const invalidateSessionParseCacheEntry = vi.hoisted(() => vi.fn())
const scanAiVaultSessions = vi.hoisted(() => vi.fn())

vi.mock('../parse-cache/session-parse-cache-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateSessionParseCacheEntry
}))
vi.mock('../session-scanner', () => ({ scanAiVaultSessions }))
vi.mock('../parse-cache/session-parse-cache-persistence', () => ({
  flushSessionParseCachePersist: vi.fn(() => Promise.resolve()),
  initSessionParseCachePersistence: vi.fn()
}))
vi.mock('../session-subagent-reader', () => ({
  listLocalAiVaultSubagentSessions: vi.fn(() => Promise.resolve({ sessions: [], issues: [] }))
}))

const sent: { type: string; id?: number }[] = []

function emit(message: unknown): void {
  process.emit('message', message as never, undefined as never)
}

async function runScan(id: number): Promise<void> {
  emit({ type: 'request', id, operation: 'scan', options: {} })
  await vi.waitFor(() => expect(sent.some((message) => message.id === id)).toBe(true))
}

function invalidationsFor(path: string): number {
  return invalidateSessionParseCacheEntry.mock.calls.filter((call) => call[0] === path).length
}

describe('AI Vault service entry cache invalidation', () => {
  beforeAll(async () => {
    process.send = ((message: { type: string; id?: number }) => {
      sent.push(message)
      return true
    }) as typeof process.send
    await import('./session-scanner-service-entry')
    emit({ type: 'init', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION })
  })

  beforeEach(() => {
    sent.length = 0
    invalidateSessionParseCacheEntry.mockClear()
    scanAiVaultSessions.mockResolvedValue({ sessions: [], issues: [], scannedAt: '2026-08-10' })
  })

  it('keeps re-applying while another request is still executing', async () => {
    let releaseSlowScan: (() => void) | undefined
    scanAiVaultSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSlowScan = () =>
            resolve({ sessions: [], issues: [], scannedAt: '2026-08-10' } as never)
        })
    )
    // Subagents can overlap scans on the interactive lane; titles share the scan lane.
    emit({ type: 'request', id: 10, operation: 'scan', options: {} })
    await vi.waitFor(() => expect(releaseSlowScan).toBeDefined())

    emit({ type: 'invalidate', generation: 2, paths: ['/transcripts/b.jsonl'] })
    emit({ type: 'request', id: 11, operation: 'subagents', request: {} })
    await vi.waitFor(() => expect(sent.some((message) => message.id === 11)).toBe(true))

    expect(invalidationsFor('/transcripts/b.jsonl')).toBe(2)

    releaseSlowScan?.()
    await vi.waitFor(() => expect(sent.some((message) => message.id === 10)).toBe(true))
    expect(invalidationsFor('/transcripts/b.jsonl')).toBe(3)

    await runScan(12)
    expect(invalidationsFor('/transcripts/b.jsonl')).toBe(3)
  })

  it('sends rate-limited progress under the running scan id, and none once it settles', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    let signal: AbortSignal | undefined
    let releaseScan: (() => void) | undefined
    scanAiVaultSessions.mockImplementationOnce(
      (options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal = options.signal
          releaseScan = () => resolve({ sessions: [], issues: [], scannedAt: '2026-08-10' })
        })
    )
    try {
      emit({ type: 'request', id: 20, operation: 'scan', options: {} })
      await vi.waitFor(() => expect(signal).toBeDefined())

      noteAiVaultScanWorkChanged(signal)
      now += 1_000
      noteAiVaultScanWorkChanged(signal)
      const progress = (): typeof sent => sent.filter((message) => message.type === 'progress')
      const work = expect.objectContaining({ stage: 'finding' })
      expect(progress()).toEqual([
        { type: 'progress', id: 20, work },
        { type: 'progress', id: 20, work }
      ])

      releaseScan?.()
      await vi.waitFor(() => expect(sent.some((message) => message.type === 'result')).toBe(true))
      now += 10_000
      noteAiVaultScanWorkChanged(signal)
      expect(progress()).toHaveLength(2)
    } finally {
      clock.mockRestore()
    }
  })
  it('answers search status at admission while the interactive lane is occupied', async () => {
    let release!: () => void
    vi.mocked(listLocalAiVaultSubagentSessions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ sessions: [], issues: [] })
        })
    )
    emit({ type: 'request', id: 30, operation: 'subagents', request: {} })
    await vi.waitFor(() => expect(release).toBeDefined())
    try {
      emit({ type: 'request', id: 31, operation: 'searchStatus' })
      await vi.waitFor(() =>
        expect(sent).toContainEqual(expect.objectContaining({ type: 'result', id: 31 }))
      )
      expect(sent.some((message) => message.id === 30)).toBe(false)
    } finally {
      release()
      await vi.waitFor(() => expect(sent.some((message) => message.id === 30)).toBe(true))
    }
  })
})
