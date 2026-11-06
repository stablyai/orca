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

describe('zcode official runtime discovery', () => {
  it('resolves a desktop executable to its bundled CLI and provider config', () => {
    expect(
      resolveZcodeOfficialRuntime('/opt/ZCode/zcode', {
        existsSync: (path) => LINUX_INSTALL.has(path),
        realpathSync: (path) => path,
        platform: 'linux'
      })
    ).toEqual({
      electron: '/opt/ZCode/zcode',
      bundle: '/opt/ZCode/resources/glm/zcode.cjs',
      builtinProviderConfig: '/opt/ZCode/resources/config/provider/zcode-builtin.json'
    })
  })

  it('resolves macOS app and Windows per-user layouts', () => {
    expect(
      probeZcodeOfficialRuntimes([], {
        existsSync: (path) => MACOS_INSTALL.has(path),
        realpathSync: (path) => path,
        platform: 'darwin'
      })
    ).toMatchObject({
      electron: '/Applications/ZCode.app/Contents/MacOS/ZCode',
      bundle: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
    })

    const windowsInstall = new Set([
      'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\ZCode.exe',
      'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
    ])
    expect(
      probeZcodeOfficialRuntimes([], {
        existsSync: (path) => windowsInstall.has(path),
        realpathSync: (path) => path,
        platform: 'win32',
        home: 'C:\\Users\\test',
        localAppData: 'C:\\Users\\test\\AppData\\Local'
      })
    ).toEqual({
      electron: 'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\ZCode.exe',
      bundle: 'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
    })
  })

  it('does not mistake a standalone CLI or a root without zcode.cjs for Desktop', () => {
    expect(
      resolveZcodeOfficialRuntime('/usr/local/bin/zcode', {
        existsSync: (path) => path === '/usr/local/bin/zcode',
        realpathSync: (path) => path
      })
    ).toBeNull()
    expect(
      probeZcodeOfficialRuntimes([], {
        existsSync: (path) => path === '/opt/ZCode/zcode',
        platform: 'linux'
      })
    ).toBeNull()
  })
})
