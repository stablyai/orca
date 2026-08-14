import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'

const invalidateSessionParseCacheEntry = vi.hoisted(() => vi.fn())
const scanAiVaultSessions = vi.hoisted(() => vi.fn())

// Only the invalidation hook is replaced; the title reader shares this module.
vi.mock('./session-scanner-parse-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateSessionParseCacheEntry
}))
vi.mock('./session-scanner', () => ({ scanAiVaultSessions }))
vi.mock('./session-parse-cache-persistence', () => ({
  flushSessionParseCachePersist: vi.fn(() => Promise.resolve()),
  initSessionParseCachePersistence: vi.fn()
}))
vi.mock('./session-subagent-reader', () => ({
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

  it('re-applies an invalidation once and then stops re-evicting the path', async () => {
    emit({ type: 'invalidate', generation: 1, paths: ['/transcripts/a.jsonl'] })
    expect(invalidationsFor('/transcripts/a.jsonl')).toBe(1)

    // The request that overlapped the invalidation still gets the re-apply, so a
    // read that started before it cannot leave pre-edit content cached.
    await runScan(1)
    expect(invalidationsFor('/transcripts/a.jsonl')).toBe(2)

    // Every later request must not keep paying for a consumed invalidation.
    await runScan(2)
    expect(invalidationsFor('/transcripts/a.jsonl')).toBe(2)
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
    // 'subagents' runs on the interactive lane, so it overlaps the cache-lane
    // scan; 'titles' would not, it shares the cache lane with scans.
    emit({ type: 'request', id: 10, operation: 'scan', options: {} })
    await vi.waitFor(() => expect(releaseSlowScan).toBeDefined())

    emit({ type: 'invalidate', generation: 2, paths: ['/transcripts/b.jsonl'] })
    emit({ type: 'request', id: 11, operation: 'subagents', request: {} })
    await vi.waitFor(() => expect(sent.some((message) => message.id === 11)).toBe(true))

    // The scan is still reading, so the path stays armed rather than draining.
    expect(invalidationsFor('/transcripts/b.jsonl')).toBe(2)

    releaseSlowScan?.()
    await vi.waitFor(() => expect(sent.some((message) => message.id === 10)).toBe(true))
    expect(invalidationsFor('/transcripts/b.jsonl')).toBe(3)

    await runScan(12)
    expect(invalidationsFor('/transcripts/b.jsonl')).toBe(3)
  })
})
