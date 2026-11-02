import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { opencodeDiscoveries } from './session-scanner-opencode-sources'

const {
  discoverOpenCodeSessionsMock,
  listOpenCodeDatabasesMock,
  listOpenCodeDatabasesInDirectoryMock,
  listOpenCode2SessionsMock
} = vi.hoisted(() => ({
  discoverOpenCodeSessionsMock: vi.fn(),
  listOpenCodeDatabasesMock: vi.fn(),
  listOpenCodeDatabasesInDirectoryMock: vi.fn(),
  listOpenCode2SessionsMock: vi.fn().mockResolvedValue([])
}))

vi.mock('./session-scanner-opencode-sqlite-worker-spawn', () => ({
  listOpenCode2SqliteSessionsViaWorker: listOpenCode2SessionsMock
}))

vi.mock('./session-scanner-opencode-sqlite-discovery', () => ({
  discoverOpenCodeSessions: discoverOpenCodeSessionsMock
}))

vi.mock('../opencode-usage/opencode-database-discovery', () => ({
  listOpenCodeDatabases: listOpenCodeDatabasesMock,
  listOpenCodeDatabasesInDirectory: listOpenCodeDatabasesInDirectoryMock
}))

describe('opencodeDiscoveries', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('checks the shared database for v2 sessions as well as the beta databases', async () => {
    const dbPaths = [join('/data', 'opencode.db'), join('/data', 'opencode-next.db')]
    listOpenCode2SessionsMock.mockResolvedValue([])
    await Promise.all(opencodeDiscoveries({ opencodeDbPaths: dbPaths }, [], 25, []))
    expect(listOpenCode2SessionsMock).toHaveBeenCalledWith({ dbPaths, limit: 25, issues: [] })
    await Promise.all(opencodeDiscoveries({ opencodeDbPaths: dbPaths }, [], 25, []))
    expect(discoverOpenCodeSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPaths: [dbPaths[0]]
      })
    )
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

  it('scans managed account stores that Orca launches OpenCode with', async () => {
    vi.stubEnv('XDG_DATA_HOME', '/xdg/data')
    const accountDir = join(
      '/user-data',
      'managed-data-accounts',
      'opencode',
      'a',
      'data',
      'opencode'
    )
    const accountDb = join(accountDir, 'opencode.db')
    listOpenCodeDatabasesMock.mockResolvedValue([])
    listOpenCodeDatabasesInDirectoryMock.mockResolvedValue([accountDb])
    discoverOpenCodeSessionsMock.mockResolvedValue({ agent: 'opencode', rootDir: '', files: [] })

    await Promise.all(
      opencodeDiscoveries(
        { opencodeAccountDataDirs: [accountDir, join('/xdg/data', 'opencode')] },
        [],
        25,
        []
      )
    )

    expect(listOpenCodeDatabasesInDirectoryMock).toHaveBeenCalledTimes(1)
    expect(listOpenCode2SessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ dbPaths: [accountDb] })
    )
  })
})
