import { describe, expect, it } from 'vitest'
import { resolveZcodeCliInvocation, zcodeDesktopTerminalRefusal } from './zcode-cli-invocation'

const DESKTOP_FILES = new Set(['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs'])
const officialRuntime = {
  platform: 'linux' as const,
  existsSync: (path: string): boolean => DESKTOP_FILES.has(path),
  realpathSync: (path: string): string => path
}

describe('resolveZcodeCliInvocation', () => {
  it('runs a Desktop bundle through its Electron executable as Node', () => {
    expect(
      resolveZcodeCliInvocation({
        resolveCommand: () => 'zcode',
        officialRuntime
      })
    ).toMatchObject({
      command: '/opt/ZCode/zcode',
      prefixArgs: ['/opt/ZCode/resources/glm/zcode.cjs'],
      envOverlay: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'desktop-bundle'
    })
  })

  it('keeps a standalone CLI as the command', () => {
    expect(
      resolveZcodeCliInvocation({
        resolveCommand: () => '/home/test/.local/bin/zcode',
        officialRuntime
      })
    ).toMatchObject({
      command: '/home/test/.local/bin/zcode',
      prefixArgs: [],
      envOverlay: {},
      source: 'standalone'
    })
  })

  it('preserves a quoted multi-token Command override', () => {
    expect(
      resolveZcodeCliInvocation({
        commandSettings: {
          agentCmdOverrides: { zcode: 'node "/home/test/ZCode CLI/zcode.cjs"' }
        },
        resolveCommand: (command) => (command === 'node' ? '/usr/bin/node' : command),
        officialRuntime: { ...officialRuntime, existsSync: () => false }
      })
    ).toMatchObject({
      command: '/usr/bin/node',
      prefixArgs: ['/home/test/ZCode CLI/zcode.cjs'],
      source: 'standalone'
    })
  })

  it('refuses a Desktop bundle for terminal launches only', () => {
    const desktop = resolveZcodeCliInvocation({ resolveCommand: () => 'zcode', officialRuntime })
    const standalone = resolveZcodeCliInvocation({
      resolveCommand: () => '/usr/local/bin/zcode',
      officialRuntime: { ...officialRuntime, existsSync: () => false }
    })
    expect(zcodeDesktopTerminalRefusal(desktop)).toMatch(/terminal TUI/)
    expect(zcodeDesktopTerminalRefusal(standalone)).toBeNull()
  })
})
