import { describe, expect, it } from 'vitest'
import { resolveZcodeCliInvocation, assertZcodeTerminalInvocation } from './zcode-cli-invocation'

const DESKTOP_FILES = new Set(['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs'])
const officialRuntime = {
  platform: 'linux' as const,
  exists: async (path: string): Promise<boolean> => DESKTOP_FILES.has(path),
  realpath: async (path: string): Promise<string> => path
}

describe('resolveZcodeCliInvocation', () => {
  it('runs a Desktop bundle through its Electron executable as Node', async () => {
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

  it('keeps a standalone CLI as the command', async () => {
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

  it('preserves a quoted multi-token Command override', async () => {
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
      source: 'standalone'
    })
  })

  it('refuses a Desktop bundle for terminal launches only', async () => {
    await expect(
      assertZcodeTerminalInvocation({ resolveCommand: () => 'zcode', officialRuntime })
    ).rejects.toThrow(/terminal TUI/)
    await expect(
      assertZcodeTerminalInvocation({
        resolveCommand: () => '/usr/local/bin/zcode',
        officialRuntime: { ...officialRuntime, exists: async () => false }
      })
    ).resolves.toBeUndefined()
  })
})
