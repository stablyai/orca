import { expect, it, vi } from 'vitest'
import { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'
import type { RuntimeStore } from './runtime-store-contract'

const apply = vi.hoisted(() =>
  vi.fn(async (_settings: unknown, options: { persist?: () => Promise<void> }) => {
    await options.persist?.()
    return null
  })
)
const indexStatus = vi.hoisted(() => ({
  value: {
    enabled: true,
    historyDays: null,
    indexSizeBytes: 0,
    available: true,
    applied: true
  } as Record<string, unknown>
}))
const searchAiVaultSessions = vi.hoisted(() => vi.fn())
vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applyAiVaultSearchSettings: apply,
  readAiVaultSearchIndexStatus: () => indexStatus.value
}))
vi.mock('../ai-vault/cached-session-list', () => ({
  listAiVaultSessions: vi.fn(),
  readAiVaultSearchCoverage: vi.fn(),
  searchAiVaultSessions
}))

it('does not acknowledge enabling until the durable store barrier completes', async () => {
  let release!: () => void
  const flushed = new Promise<void>((resolve) => {
    release = resolve
  })
  const flushPendingOrThrowAsync = vi.fn(() => flushed)
  const store = {
    getSettings: () => ({}),
    updateSettings: vi.fn(),
    flushPendingOrThrowAsync
  } as unknown as RuntimeStore
  const commands = new RuntimeAiVaultCommands(
    () => null,
    () => store
  )
  let acknowledged = false
  const pending = commands.configureSearch({ enabled: true }).then((status) => {
    acknowledged = true
    return status
  })
  await vi.waitFor(() =>
    expect(flushPendingOrThrowAsync).toHaveBeenCalledWith({ drainToStableGeneration: false })
  )
  expect(acknowledged).toBe(false)
  release()
  expect(await pending).toMatchObject({ enabled: true, applied: true })
})

it('reports persistence failure instead of returning a successful policy acknowledgement', async () => {
  const store = {
    getSettings: () => ({}),
    updateSettings: vi.fn(),
    flushPendingOrThrowAsync: vi.fn().mockRejectedValue(new Error('disk full'))
  } as unknown as RuntimeStore
  const commands = new RuntimeAiVaultCommands(
    () => null,
    () => store
  )
  await expect(commands.configureSearch({ enabled: true })).rejects.toThrow('disk full')
})

it('answers from the existing index while a policy apply is still in flight', async () => {
  const coverage = {
    enabled: true,
    sessionsIndexed: 1,
    messagesIndexed: 1,
    providers: [],
    backfill: 'complete' as const,
    filesPending: 0,
    lastIndexedAt: null
  }
  searchAiVaultSessions.mockResolvedValue({ hits: [], route: 'and', durationMs: 1, coverage })
  const commands = new RuntimeAiVaultCommands(() => null)
  indexStatus.value = {
    enabled: true,
    historyDays: null,
    indexSizeBytes: 0,
    available: true,
    applied: false,
    reason: 'Index policy application or persistence failed or is pending.'
  }

  await expect(commands.search({ query: 'needle' })).resolves.toMatchObject({ coverage })
  expect(searchAiVaultSessions).toHaveBeenCalled()
})

it('refuses a query when the index is unavailable, with a message even if the host omits one', async () => {
  searchAiVaultSessions.mockClear()
  const commands = new RuntimeAiVaultCommands(() => null)
  indexStatus.value = {
    enabled: false,
    historyDays: null,
    indexSizeBytes: null,
    available: false,
    applied: false
  }

  expect(() => commands.search({ query: 'needle' })).toThrow(/unavailable on this host/)
  expect(searchAiVaultSessions).not.toHaveBeenCalled()
})
