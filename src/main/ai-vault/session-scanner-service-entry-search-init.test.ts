import { beforeAll, expect, it, vi } from 'vitest'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'

// The service entry's stdio is piped to the parent's console
// (session-scanner-service-spawn.ts), so anything it logs leaves the child.

const INDEX_PATH = '/Users/somebody/Library/orca/session-index.sqlite'

vi.mock('../ai-vault-search/session-search-service', () => ({
  SessionSearchService: class {
    constructor() {
      throw new Error(`unable to open database file ${INDEX_PATH}`)
    }
  }
}))
vi.mock('./session-scanner', () => ({ scanAiVaultSessions: vi.fn() }))
vi.mock('./session-parse-cache-persistence', () => ({
  flushSessionParseCachePersist: vi.fn(() => Promise.resolve()),
  initSessionParseCachePersistence: vi.fn()
}))
vi.mock('./session-subagent-reader', () => ({
  listLocalAiVaultSubagentSessions: vi.fn(() => Promise.resolve({ sessions: [], issues: [] }))
}))

let logged: unknown[] = []

beforeAll(async () => {
  process.send = (() => true) as typeof process.send
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged = args
  })
  await import('./session-scanner-service-entry')
  process.emit(
    'message',
    {
      type: 'init',
      protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION,
      sessionSearch: { databasePath: INDEX_PATH, enabled: true, historyDays: null }
    } as never,
    undefined as never
  )
})

it('logs only the error name when the search index cannot be opened', () => {
  expect(logged[0]).toBe('[ai-vault] session search index unavailable:')
  expect(logged[1]).toBe('Error')

  // Neither the thrown object nor the user's index path may reach the pipe.
  for (const value of logged) {
    expect(value).not.toBeInstanceOf(Error)
    expect(String(value)).not.toContain(INDEX_PATH)
  }
})
