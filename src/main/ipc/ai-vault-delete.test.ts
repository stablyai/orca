import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteAiVaultSessionFile: vi.fn(),
  invalidateAiVaultSessionListCache: vi.fn(),
  invalidateSessionParseCacheEntry: vi.fn(),
  invalidateAiVaultBackgroundCache: vi.fn(),
  getAiVaultWslHomeDirs: vi.fn(),
  forgetDeletedVaultSessionRecords: vi.fn(),
  getHostAgentSessionRecordStore: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ai-vault/cached-session-list', () => ({
  getAiVaultWslHomeDirs: mocks.getAiVaultWslHomeDirs,
  invalidateAiVaultSessionListCache: mocks.invalidateAiVaultSessionListCache
}))
vi.mock('../ai-vault/session-delete', () => ({
  deleteAiVaultSessionFile: mocks.deleteAiVaultSessionFile
}))
vi.mock('../ai-vault/session-scanner-parse-cache', () => ({
  invalidateSessionParseCacheEntry: mocks.invalidateSessionParseCacheEntry
}))
vi.mock('../ai-vault/session-scanner-background', () => ({
  invalidateAiVaultBackgroundCache: mocks.invalidateAiVaultBackgroundCache
}))
vi.mock('../agent-launch/agent-session-vault-delete-forget', () => ({
  forgetDeletedVaultSessionRecords: mocks.forgetDeletedVaultSessionRecords
}))
vi.mock('../agent-launch/agent-session-record-store-host', () => ({
  getHostAgentSessionRecordStore: mocks.getHostAgentSessionRecordStore
}))

const { deleteAiVaultSession } = await import('./ai-vault-delete')

const args = {
  agent: 'gemini' as const,
  sessionId: 'session-1',
  filePath: '/home/ada/.gemini/tmp/sess.json',
  executionHostId: 'local' as const
}
const deps = () => ({ invalidateMultiHostListCache: vi.fn() })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getAiVaultWslHomeDirs.mockResolvedValue([])
  mocks.invalidateAiVaultBackgroundCache.mockResolvedValue(undefined)
  mocks.deleteAiVaultSessionFile.mockResolvedValue({ outcome: 'deleted' })
})

describe('deleteAiVaultSession resume-record forget', () => {
  it('forgets the correlated host-private resume records after a real delete', async () => {
    const forgetSessionRecords = vi.fn()

    await deleteAiVaultSession(args, { ...deps(), forgetSessionRecords })

    expect(forgetSessionRecords).toHaveBeenCalledWith({
      baseAgent: 'gemini',
      scannedProviderSessionId: 'session-1',
      scannedTranscriptPath: args.filePath,
      scannedExecutionHostId: 'local'
    })
  })

  it('defaults the forget seam to the host-wide singleton record store', async () => {
    const store = { records: 'sentinel' }
    mocks.getHostAgentSessionRecordStore.mockReturnValue(store)

    // Omitted executionHostId (older renderer) must still scope to 'local'.
    await deleteAiVaultSession({ ...args, executionHostId: undefined }, deps())

    expect(mocks.forgetDeletedVaultSessionRecords).toHaveBeenCalledWith(store, {
      baseAgent: 'gemini',
      scannedProviderSessionId: 'session-1',
      scannedTranscriptPath: args.filePath,
      scannedExecutionHostId: 'local'
    })
  })

  it('skips the forget for a non-resumable agent, a missing session id, or a rejection', async () => {
    const forgetSessionRecords = vi.fn()
    const sharedDeps = { ...deps(), forgetSessionRecords }

    await deleteAiVaultSession({ ...args, agent: 'rovo' }, sharedDeps)
    await deleteAiVaultSession({ ...args, sessionId: undefined }, sharedDeps)
    mocks.deleteAiVaultSessionFile.mockResolvedValue({
      outcome: 'rejected',
      agent: 'gemini',
      reason: 'non-local-host'
    })
    await deleteAiVaultSession(args, sharedDeps)

    expect(forgetSessionRecords).not.toHaveBeenCalled()
    expect(mocks.forgetDeletedVaultSessionRecords).not.toHaveBeenCalled()
  })
})
