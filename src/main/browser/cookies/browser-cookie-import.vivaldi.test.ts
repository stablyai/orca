import { pbkdf2Sync } from 'node:crypto'
import type * as fsModule from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existingPaths, runProcessSyncMock } = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fsModule>('node:fs')
  return {
    ...actual,
    existsSync: (p: string) => existingPaths.has(p.replaceAll('\\', '/'))
  }
})
vi.mock('@orca/process-host', () => ({ runProcessSync: runProcessSyncMock }))

import { detectInstalledBrowsers } from './sources/browser-cookie-detection'
import { getEncryptionKey } from './sources/browser-cookie-key'

const originalPlatform = process.platform
const originalEnv = { ...process.env }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  existingPaths.clear()
  runProcessSyncMock.mockReset()
  process.env.HOME = '/home/test'
  process.env.LOCALAPPDATA = 'C:/Users/test/AppData/Local'
  process.env.XDG_CONFIG_HOME = '/home/test/.config'
})

afterEach(() => {
  setPlatform(originalPlatform)
  process.env = { ...originalEnv }
})

describe('Vivaldi cookie import source', () => {
  it.each([
    ['darwin', '/home/test/Library/Application Support/Vivaldi/Default/Cookies'],
    ['win32', 'C:/Users/test/AppData/Local/Vivaldi/User Data/Default/Network/Cookies'],
    ['linux', '/home/test/.config/vivaldi/Default/Cookies']
  ] as const)('detects the %s profile store', (platform, cookiesPath) => {
    setPlatform(platform)
    existingPaths.add(cookiesPath)

    const vivaldi = detectInstalledBrowsers().find((browser) => browser.family === 'vivaldi')

    expect(vivaldi?.label).toBe('Vivaldi')
    expect(vivaldi?.cookiesPath.replaceAll('\\', '/')).toBe(cookiesPath)
  })

  it('reads the Linux keyring secret Vivaldi stores under the Chrome application name', () => {
    setPlatform('linux')
    existingPaths.add('/home/test/.config/vivaldi/Default/Cookies')
    runProcessSyncMock.mockImplementation(({ args }: { args: string[] }) =>
      args.join(' ') === 'lookup application chrome'
        ? { code: 0, timedOut: false, stdout: 'vivaldi-secret\n', stderr: '' }
        : { code: 1, timedOut: false, stdout: '', stderr: '' }
    )
    const vivaldi = detectInstalledBrowsers().find((browser) => browser.family === 'vivaldi')

    const key = getEncryptionKey(vivaldi!.keychainService!, vivaldi!.keychainAccount!, vivaldi)

    expect(key).toMatchObject({
      keysByVersion: { v11: pbkdf2Sync('vivaldi-secret', 'saltysalt', 1, 16, 'sha1') }
    })
  })
})
