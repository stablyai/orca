import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { opencodeDiscoveries } from './session-scanner-opencode-sources'

const { discoverOpenCodeSessionsMock, listOpenCodeDatabasesMock } = vi.hoisted(() => ({
  discoverOpenCodeSessionsMock: vi.fn(),
  listOpenCodeDatabasesMock: vi.fn()
}))

vi.mock('./session-scanner-opencode-sqlite-discovery', () => ({
  discoverOpenCodeSessions: discoverOpenCodeSessionsMock
}))

vi.mock('../opencode-usage/scanner', () => ({
  listOpenCodeDatabases: listOpenCodeDatabasesMock
}))

describe('opencodeDiscoveries', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('discovers local storage from the OpenCode XDG data directory', async () => {
    vi.stubEnv('XDG_DATA_HOME', '/xdg/data')
    vi.stubEnv('OPENCODE_CONFIG_DIR', '/opencode/config')
    listOpenCodeDatabasesMock.mockResolvedValue([])
    discoverOpenCodeSessionsMock.mockResolvedValue({
      agent: 'opencode',
      rootDir: '/xdg/data/opencode/storage',
      files: []
    })
    const issues = []

    await Promise.all(opencodeDiscoveries({}, [], 25, issues))

    expect(discoverOpenCodeSessionsMock).toHaveBeenCalledWith({
      storageDir: join('/xdg/data', 'opencode', 'storage'),
      dbPaths: [],
      limitPerAgent: 25,
      issues
    })
  })
})
