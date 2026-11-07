import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault/contracts/ai-vault-types'
import {
  resetLocalAiVaultScanProgressForTests,
  type LocalAiVaultScanProgressHandle
} from './ai-vault-local-scan-progress'

const { scanAiVaultSessionsInService } = vi.hoisted(() => ({
  scanAiVaultSessionsInService: vi.fn()
}))

vi.mock('./scan-service/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService
}))

import { listAiVaultSessions, resetAiVaultSessionListCacheForTests } from './cached-session-list'

function scanResult(scannedAt: string): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt }
}

const workspace = { limit: 250, scopePaths: ['/repo/wt'], scopeOnly: true }
const project = { limit: 250, scopePaths: ['/repo/wt', '/repo/sibling'], scopeOnly: true }
const all = { limit: 250, scopePaths: ['/repo/wt', '/repo/sibling'] }

describe('listAiVaultSessions per-scope cache', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    resetAiVaultSessionListCacheForTests()
    resetLocalAiVaultScanProgressForTests()
    scanAiVaultSessionsInService.mockReset()
  })
  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
    resetLocalAiVaultScanProgressForTests()
    vi.restoreAllMocks()
  })

  it('switches between Workspace, Project and All without rescanning until a forced refresh', async () => {
    scanAiVaultSessionsInService
      .mockResolvedValueOnce(scanResult('workspace'))
      .mockResolvedValueOnce(scanResult('project'))
      .mockResolvedValueOnce(scanResult('all'))
    for (const request of [workspace, project, all]) {
      await listAiVaultSessions(request)
    }

    const again = await Promise.all([workspace, project, all].map((r) => listAiVaultSessions(r)))

    expect(again.map((result) => result.scannedAt)).toEqual(['workspace', 'project', 'all'])

    scanAiVaultSessionsInService
      .mockResolvedValueOnce(scanResult('forced-all'))
      .mockResolvedValueOnce(scanResult('workspace-after-force'))
    await listAiVaultSessions({ ...all, force: true })
    expect((await listAiVaultSessions(workspace)).scannedAt).toBe('workspace-after-force')
  })

  it('keeps a scan that began before a forced refresh out of the cache', async () => {
    let finishBefore: (value: AiVaultListResult) => void = () => {}
    scanAiVaultSessionsInService.mockImplementationOnce(
      async (_options, _signal, progress?: LocalAiVaultScanProgressHandle) => {
        const value = await new Promise<AiVaultListResult>((resolve) => {
          finishBefore = resolve
        })
        progress?.finish(null)
        return value
      }
    )
    const pending = listAiVaultSessions(workspace)
    await vi.waitFor(() => expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1))
    scanAiVaultSessionsInService.mockResolvedValueOnce(scanResult('forced-all'))
    await listAiVaultSessions({ ...all, force: true })
    finishBefore(scanResult('before-change'))
    await pending
    scanAiVaultSessionsInService.mockResolvedValueOnce(scanResult('after-change'))

    expect((await listAiVaultSessions(workspace)).scannedAt).toBe('after-change')
  })
})
