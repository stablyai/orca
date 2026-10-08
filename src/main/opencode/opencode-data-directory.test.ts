import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveOpenCodeDataDirectory,
  resolveOpenCodeDatabasePath,
  resolveOpenCodeStorageDirectory
} from './opencode-data-directory'

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('resolveOpenCodeDataDirectory', () => {
  const realPlatform = process.platform

  afterEach(() => {
    stubPlatform(realPlatform)
  })

  it('uses XDG_DATA_HOME when it is configured', () => {
    expect(resolveOpenCodeDataDirectory({ XDG_DATA_HOME: ' /custom/data ' }, '/users/test')).toBe(
      join('/custom/data', 'opencode')
    )
  })

  it.each<NodeJS.Platform>(['win32', 'darwin', 'linux'])(
    'uses the OpenCode cross-platform default instead of app-data directories on %s',
    (platform) => {
      stubPlatform(platform)
      const environment = {
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
        APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
        OPENCODE_CONFIG_DIR: 'C:\\Users\\test\\.config\\opencode'
      }

      expect(resolveOpenCodeDataDirectory(environment, '/users/test')).toBe(
        join('/users/test', '.local', 'share', 'opencode')
      )
    }
  )

  it('derives legacy storage from the same data directory', () => {
    expect(resolveOpenCodeStorageDirectory({}, '/users/test')).toBe(
      join('/users/test', '.local', 'share', 'opencode', 'storage')
    )
  })

  it('resolves default, relative, absolute and in-memory database selections', () => {
    const environment = { XDG_DATA_HOME: '/pinned' }
    expect(resolveOpenCodeDatabasePath(environment)).toBe(
      join('/pinned', 'opencode', 'opencode.db')
    )
    expect(resolveOpenCodeDatabasePath({ ...environment, OPENCODE_DB: 'custom.db' })).toBe(
      join('/pinned', 'opencode', 'custom.db')
    )
    const absolute = join(process.cwd(), 'selected.db')
    expect(resolveOpenCodeDatabasePath({ ...environment, OPENCODE_DB: absolute })).toBe(absolute)
    expect(resolveOpenCodeDatabasePath({ ...environment, OPENCODE_DB: ':memory:' })).toBeNull()
  })
})
