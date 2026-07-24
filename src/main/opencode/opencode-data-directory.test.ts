import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveOpenCodeDataDirectory,
  resolveOpenCodeStorageDirectory
} from './opencode-data-directory'

describe('resolveOpenCodeDataDirectory', () => {
  it('uses XDG_DATA_HOME when it is configured', () => {
    expect(resolveOpenCodeDataDirectory({ XDG_DATA_HOME: ' /custom/data ' }, '/users/test')).toBe(
      join('/custom/data', 'opencode')
    )
  })

  it('uses the OpenCode cross-platform default instead of Windows app-data directories', () => {
    const environment = {
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      OPENCODE_CONFIG_DIR: 'C:\\Users\\test\\.config\\opencode'
    }

    expect(resolveOpenCodeDataDirectory(environment, '/users/test')).toBe(
      join('/users/test', '.local', 'share', 'opencode')
    )
  })

  it('derives legacy storage from the same data directory', () => {
    expect(resolveOpenCodeStorageDirectory({}, '/users/test')).toBe(
      join('/users/test', '.local', 'share', 'opencode', 'storage')
    )
  })
})
