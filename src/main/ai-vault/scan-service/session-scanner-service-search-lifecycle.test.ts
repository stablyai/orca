import '../../ai-vault-search/session-search-worker.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionSearchIndexer } from '../../ai-vault-search/session-search-indexer'
import { SessionSearchReaders } from '../../ai-vault-search/session-search-readers'
import { openSessionSearchIndexerHarness } from '../../ai-vault-search/session-search-indexer-test-fixture'
import { SessionScannerServiceSearch } from './session-scanner-service-search'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(['initialization', 'retirement'] as const)(
  'answers search/status and settles cancelled or timed-out maintenance during slow %s',
  async (phase) => {
    const harness = await openSessionSearchIndexerHarness('ss-transition-deadline')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const initialize = vi.spyOn(SessionSearchIndexer.prototype, 'initialize').mockResolvedValue()
    vi.spyOn(SessionSearchIndexer.prototype, 'start').mockResolvedValue()
    const subject = new SessionScannerServiceSearch()
    const init = {
      databasePath: harness.databasePath,
      roots: harness.roots,
      settings: { enabled: true, historyDays: null }
    }
    if (phase === 'retirement') {
      await subject.apply(init)
      vi.spyOn(SessionSearchReaders.prototype, 'close').mockImplementationOnce(() => blocked)
    } else {
      initialize.mockImplementationOnce(() => blocked)
    }
    const applying = subject.apply(init)
    try {
      vi.useFakeTimers()
      expect(
        await subject.execute({
          type: 'request',
          id: 1,
          operation: 'searchSessions',
          request: { query: 'needle' }
        })
      ).toMatchObject({ value: { kind: 'unavailable', reason: 'not-ready' } })
      expect(
        await subject.execute({ type: 'request', id: 2, operation: 'searchStatus' })
      ).toMatchObject({ value: { enabled: true } })
      for (const operation of ['searchReconcile', 'searchClear'] as const) {
        const controller = new AbortController()
        const pending = subject.execute({ type: 'request', id: 3, operation }, controller.signal)
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      }
      const clear = expect(
        subject.execute({ type: 'request', id: 4, operation: 'searchClear' })
      ).rejects.toThrow('Could not complete')
      await vi.advanceTimersByTimeAsync(10_000)
      await clear
    } finally {
      release()
      vi.useRealTimers()
      await applying
      await subject.close()
      await harness.cleanup()
    }
  }
)
