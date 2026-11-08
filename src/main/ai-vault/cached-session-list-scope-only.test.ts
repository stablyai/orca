import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { scanAiVaultSessionsInService } = vi.hoisted(() => ({
  scanAiVaultSessionsInService: vi.fn()
}))

vi.mock('./scan-service/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService
}))

import { listAiVaultSessions, resetAiVaultSessionListCacheForTests } from './cached-session-list'

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  resetAiVaultSessionListCacheForTests()
  scanAiVaultSessionsInService.mockResolvedValue({ sessions: [], issues: [], scannedAt: 'scan' })
})

afterEach(() => {
  resetAiVaultSessionListCacheForTests()
  vi.restoreAllMocks()
  scanAiVaultSessionsInService.mockReset()
})

it('answers a scope-only request from a cached full list for the same paths, never the reverse', async () => {
  const scopePaths = ['/repo/app']

  await listAiVaultSessions({ scopePaths })
  await listAiVaultSessions({ scopePaths, scopeOnly: true })
  expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)

  resetAiVaultSessionListCacheForTests()
  await listAiVaultSessions({ scopePaths, scopeOnly: true })
  await listAiVaultSessions({ scopePaths })
  expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(3)
})
