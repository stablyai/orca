import { describe, expect, it } from 'vitest'
import { resolveZcodeCliInvocation } from './zcode-cli-invocation'

const DESKTOP_FILES = new Set(['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs'])
const officialRuntime = {
  platform: 'linux' as const,
  exists: async (path: string): Promise<boolean> => DESKTOP_FILES.has(path),
  realpath: async (path: string): Promise<string> => path
}

describe('resolveZcodeCliInvocation', async () => {
  it('uses the desktop executable as Node with its bundled CLI', async () => {
    expect(
      await resolveZcodeCliInvocation({
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

  it('prefers a resolved standalone CLI over a conventional desktop install', async () => {
    expect(
      await resolveZcodeCliInvocation({
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

  it('preserves a supported multi-token Node bundle override', async () => {
    expect(
      await resolveZcodeCliInvocation({
        commandSettings: {
          agentCmdOverrides: { zcode: 'node "/home/test/ZCode CLI/zcode.cjs"' }
        },
        resolveCommand: (command) => (command === 'node' ? '/usr/bin/node' : command),
        officialRuntime: { ...officialRuntime, exists: async () => false }
      })
    ).toMatchObject({
      command: '/usr/bin/node',
      prefixArgs: ['/home/test/ZCode CLI/zcode.cjs'],
      envOverlay: {},
      source: 'standalone'
    })
  })

  it('parses a Windows Node bundle override without consuming path separators', async () => {
    expect(
      await resolveZcodeCliInvocation({
        commandSettings: {
          agentCmdOverrides: { zcode: 'node "C:\\ZCode CLI\\zcode.cjs"' }
        },
        platform: 'win32',
        resolveCommand: (command) =>
          command === 'node' ? 'C:\\Program Files\\nodejs\\node.exe' : command,
        officialRuntime: { platform: 'win32', exists: async () => false }
      })
    ).toMatchObject({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\ZCode CLI\\zcode.cjs'],
      source: 'standalone'
    })
  })
})
