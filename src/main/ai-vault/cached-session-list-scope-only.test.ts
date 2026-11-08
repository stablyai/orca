import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syntheticSession } from '../ai-vault-search/session-search-index-test-fixture'

const { scanAiVaultSessionsInService } = vi.hoisted(() => ({
  scanAiVaultSessionsInService: vi.fn()
}))

vi.mock('./scan-service/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService
}))

import { listAiVaultSessions, resetAiVaultSessionListCacheForTests } from './cached-session-list'

const scopePaths = ['/repo/app']

function nextScanReturns(id: string): void {
  scanAiVaultSessionsInService.mockResolvedValueOnce({
    sessions: [syntheticSession({ id, filePath: `/sessions/${id}.jsonl`, cwd: '/repo/app' })],
    issues: [],
    scannedAt: id
  })
}

async function listedIds(scopeOnly?: true): Promise<string[]> {
  const result = await listAiVaultSessions({ scopePaths, scopeOnly })
  return result.sessions.map((session) => session.id)
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  resetAiVaultSessionListCacheForTests()
})

afterEach(() => {
  resetAiVaultSessionListCacheForTests()
  vi.restoreAllMocks()
  scanAiVaultSessionsInService.mockReset()
})

it('answers a scope-only request with the rows of a cached full list for the same paths', async () => {
  nextScanReturns('full')
  nextScanReturns('scoped')

  expect(await listedIds()).toEqual(['full'])
  expect(await listedIds(true)).toEqual(['full'])
})

it('never answers a full request with the rows of a cached scope-only list', async () => {
  nextScanReturns('scoped')
  nextScanReturns('full')

  expect(await listedIds(true)).toEqual(['scoped'])
  expect(await listedIds()).toEqual(['full'])
})
