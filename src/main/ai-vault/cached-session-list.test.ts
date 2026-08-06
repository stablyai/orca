import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type { AiVaultScanOptions } from './session-scanner-types'

const { scanAiVaultSessions } = vi.hoisted(() => ({ scanAiVaultSessions: vi.fn() }))

vi.mock('./session-scanner', () => ({ scanAiVaultSessions }))
vi.mock('../wsl', () => ({
  getWslHomeAsync: vi.fn(),
  listWslDistrosAsync: vi.fn().mockResolvedValue([])
}))

import {
  configureAiVaultSessionSources,
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from './cached-session-list'

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-08-05T00:00:00.000Z'
}

describe('cached Agent History source configuration', () => {
  beforeEach(() => {
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessions.mockReset()
    scanAiVaultSessions.mockResolvedValue(EMPTY_RESULT)
  })

  it('scans the configured host Codex session source alongside the default home', async () => {
    configureAiVaultSessionSources({
      getCodexSessionSourceHomePath: () => '/custom/codex/home',
      getAdditionalCodexHomePaths: () => ['/runtime/codex/home']
    })

    await listAiVaultSessions({ force: true })

    const options = scanAiVaultSessions.mock.calls[0]?.[0] as AiVaultScanOptions
    expect(options.additionalCodexSessionsDirs).toEqual([
      join('/custom/codex/home', 'sessions'),
      join('/runtime/codex/home', 'sessions')
    ])
    // The override adds a root. Overriding codexSessionsDir instead would drop
    // the user's real ~/.codex history from the panel.
    expect(options.codexSessionsDir).toBeUndefined()
  })

  it('rescans immediately when the configured source changes', async () => {
    let sourceHome = '/custom/codex/a'
    configureAiVaultSessionSources({ getCodexSessionSourceHomePath: () => sourceHome })

    await listAiVaultSessions()
    sourceHome = '/custom/codex/b'
    await listAiVaultSessions()

    expect(scanAiVaultSessions).toHaveBeenCalledTimes(2)
    expect(scanAiVaultSessions.mock.calls[1]?.[0]).toMatchObject({
      additionalCodexSessionsDirs: [join('/custom/codex/b', 'sessions')]
    })
  })

  it('does not join an in-flight scan for an older source', async () => {
    let sourceHome = '/custom/codex/a'
    const resolveScans: ((result: AiVaultListResult) => void)[] = []
    scanAiVaultSessions.mockImplementation(
      () => new Promise<AiVaultListResult>((resolve) => resolveScans.push(resolve))
    )
    configureAiVaultSessionSources({ getCodexSessionSourceHomePath: () => sourceHome })

    const first = listAiVaultSessions()
    await vi.waitFor(() => expect(resolveScans).toHaveLength(1))
    sourceHome = '/custom/codex/b'
    const second = listAiVaultSessions()
    await vi.waitFor(() => expect(resolveScans).toHaveLength(2))

    resolveScans.forEach((resolve) => resolve(EMPTY_RESULT))
    await Promise.all([first, second])
  })
})
