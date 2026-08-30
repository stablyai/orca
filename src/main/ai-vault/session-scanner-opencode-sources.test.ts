import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mimoCodeDiscoveries, opencodeDiscoveries } from './session-scanner-opencode-sources'

const { discoverOpenCodeSessionsMock, listOpenCodeDatabasesMock, listSqliteSessionsMock } =
  vi.hoisted(() => ({
    discoverOpenCodeSessionsMock: vi.fn(),
    listOpenCodeDatabasesMock: vi.fn(),
    listSqliteSessionsMock: vi.fn()
  }))

vi.mock('./session-scanner-opencode-sqlite-discovery', () => ({
  discoverOpenCodeSessions: discoverOpenCodeSessionsMock
}))

vi.mock('../opencode-usage/opencode-database-discovery', () => ({
  listOpenCodeDatabases: listOpenCodeDatabasesMock
}))

vi.mock('./session-scanner-opencode-sqlite-worker-spawn', () => ({
  listOpenCodeSqliteSessionsViaWorker: listSqliteSessionsMock
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

describe('mimoCodeDiscoveries', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('discovers MiMo data under MIMOCODE_HOME', async () => {
    vi.stubEnv('MIMOCODE_HOME', '/custom/mimocode')
    vi.stubEnv('XDG_DATA_HOME', '/xdg/data')
    listSqliteSessionsMock.mockResolvedValue([])
    const issues = []

    await Promise.all(mimoCodeDiscoveries({}, [], 25, issues))

    expect(listSqliteSessionsMock).toHaveBeenCalledWith({
      dbPaths: [join('/custom/mimocode', 'data', 'mimocode.db')],
      limit: 25,
      issues,
      agent: 'mimo-code'
    })
  })

  it('discovers MiMo data under XDG_DATA_HOME', async () => {
    vi.stubEnv('MIMOCODE_HOME', '')
    vi.stubEnv('XDG_DATA_HOME', '/xdg/data')
    listSqliteSessionsMock.mockResolvedValue([])
    const issues = []

    await Promise.all(mimoCodeDiscoveries({}, [], 25, issues))

    expect(listSqliteSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ dbPaths: [join('/xdg/data', 'mimocode', 'mimocode.db')] })
    )
  })

  it('discovers MiMo data under the PTY HOME fallback', async () => {
    vi.stubEnv('MIMOCODE_HOME', '')
    vi.stubEnv('XDG_DATA_HOME', '')
    vi.stubEnv('HOME', '/pty/home')
    listSqliteSessionsMock.mockResolvedValue([])
    const issues = []

    await Promise.all(mimoCodeDiscoveries({}, [], 25, issues))

    expect(listSqliteSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPaths: [join('/pty/home', '.local', 'share', 'mimocode', 'mimocode.db')]
      })
    )
  })
})
