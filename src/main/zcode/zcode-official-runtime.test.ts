// Official-runtime discovery: a PATH entry that resolves into a desktop install yields its
// executable as the Node runtime; a standalone CLI stays itself; conventional roots cover a
// missing PATH entry.

import { describe, expect, it } from 'vitest'
import { probeZcodeOfficialRuntimes, resolveZcodeOfficialRuntime } from './zcode-official-runtime'

const LINUX_INSTALL = new Set([
  '/opt/ZCode/zcode',
  '/opt/ZCode/resources/glm/zcode.cjs',
  '/opt/ZCode/resources/config/provider/zcode-builtin.json'
])
const MACOS_INSTALL = new Set([
  '/Applications/ZCode.app/Contents/MacOS/ZCode',
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json'
])

describe('zcode official runtime discovery', async () => {
  it('resolves a desktop executable to its CLI and provider config', async () => {
    expect(
      await resolveZcodeOfficialRuntime('/opt/ZCode/zcode', {
        exists: async (path) => LINUX_INSTALL.has(path),
        realpath: async (path) => path
      })
    ).toEqual({
      electron: '/opt/ZCode/zcode',
      bundle: '/opt/ZCode/resources/glm/zcode.cjs',
      builtinProviderConfig: '/opt/ZCode/resources/config/provider/zcode-builtin.json'
    })
  })

  it('resolves a per-user macOS app when no PATH candidate exists', async () => {
    const install = new Set([
      '/Users/test/Applications/ZCode.app/Contents/MacOS/ZCode',
      '/Users/test/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      '/Users/test/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json'
    ])
    expect(
      await probeZcodeOfficialRuntimes([], {
        exists: async (path) => install.has(path),
        realpath: async (path) => path,
        platform: 'darwin',
        home: '/Users/test'
      })
    ).toEqual({
      electron: '/Users/test/Applications/ZCode.app/Contents/MacOS/ZCode',
      bundle: '/Users/test/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      builtinProviderConfig:
        '/Users/test/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json'
    })
  })

  it('resolves a per-user Windows app from LOCALAPPDATA', async () => {
    const install = new Set([
      'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\ZCode.exe',
      'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
      'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\config\\provider\\zcode-builtin.json'
    ])
    expect(
      await probeZcodeOfficialRuntimes([], {
        exists: async (path) => install.has(path),
        realpath: async (path) => path,
        platform: 'win32',
        home: 'C:\\Users\\test',
        localAppData: 'C:\\Users\\test\\AppData\\Local'
      })
    ).toEqual({
      electron: 'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\ZCode.exe',
      bundle: 'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
      builtinProviderConfig:
        'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\config\\provider\\zcode-builtin.json'
    })
  })

  it('resolves the macOS app executable to Contents/Resources', async () => {
    expect(
      await probeZcodeOfficialRuntimes([], {
        exists: async (path) => MACOS_INSTALL.has(path),
        realpath: async (path) => path,
        platform: 'darwin'
      })
    ).toEqual({
      electron: '/Applications/ZCode.app/Contents/MacOS/ZCode',
      bundle: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      builtinProviderConfig:
        '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json'
    })
  })

  it('leaves a standalone CLI alone: no resources sibling, no runtime reuse', async () => {
    const exists = async (path: string): Promise<boolean> => path === '/usr/local/bin/zcode'
    expect(
      await resolveZcodeOfficialRuntime('/usr/local/bin/zcode', {
        exists,
        realpath: async (path) => path
      })
    ).toBeNull()
    expect(
      await resolveZcodeOfficialRuntime('/gone/zcode', {
        exists: async () => false,
        realpath: async (path) => path
      })
    ).toBeNull()
  })

  it('probes the conventional root when the PATH entry misses, binary or root form', async () => {
    const exists = async (path: string): Promise<boolean> =>
      LINUX_INSTALL.has(path) || path === '/opt/Other/zcode'
    expect(
      await probeZcodeOfficialRuntimes(['/opt/Other/zcode', '/opt/ZCode'], {
        exists,
        platform: 'linux'
      })
    ).toEqual({
      electron: '/opt/ZCode/zcode',
      bundle: '/opt/ZCode/resources/glm/zcode.cjs',
      builtinProviderConfig: '/opt/ZCode/resources/config/provider/zcode-builtin.json'
    })
  })

  it('still resolves an older desktop package without the provider config asset', async () => {
    expect(
      await resolveZcodeOfficialRuntime('/opt/ZCode/zcode', {
        exists: async (path) =>
          path === '/opt/ZCode/zcode' || path === '/opt/ZCode/resources/glm/zcode.cjs',
        realpath: async (path) => path
      })
    ).toEqual({
      electron: '/opt/ZCode/zcode',
      bundle: '/opt/ZCode/resources/glm/zcode.cjs'
    })
  })

  it('never takes a conventional root whose sibling bundle is absent', async () => {
    expect(
      await probeZcodeOfficialRuntimes([], {
        exists: async (path) => path === '/opt/ZCode/zcode',
        platform: 'linux'
      })
    ).toBeNull()
  })
})
