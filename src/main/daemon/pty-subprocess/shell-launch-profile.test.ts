import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyShellLaunchPlan } from './shell-launch-plan'

vi.mock('../../providers/pty-spawn-validation', () => ({
  resolveUnixShellPath: (shell: string) => shell
}))
vi.mock('../shell-ready', () => ({
  resolvePtyShellPath: (env: Record<string, string>) => env.SHELL || '/bin/zsh',
  getShellLaunchConfig: () => ({ args: ['-l'], env: {} })
}))
afterEach(() => vi.restoreAllMocks())

const base = { sessionId: 'profile-shell', cwd: '/tmp', cols: 80, rows: 24 }
describe.skipIf(process.platform === 'win32')('daemon Unix shell profiles', () => {
  it.each(['/bin/bash', '/bin/zsh', '/usr/bin/fish', '/usr/bin/nu'])(
    'uses the configured executable %s ahead of the ambient shell',
    async (shell) => {
      expect(
        await createPtyShellLaunchPlan({ ...base, shellOverride: shell }, { SHELL: '/bin/sh' })
      ).toMatchObject({ shellPath: shell, shellArgs: ['-l'] })
    }
  )
  it('uses the environment shell without a configured override', async () => {
    expect(await createPtyShellLaunchPlan(base, { SHELL: '/bin/zsh' })).toMatchObject({
      shellPath: '/bin/zsh'
    })
  })
  it.each([{ args: [] }, { args: ['--rcfile', '/tmp/orca rc'] }])(
    'preserves configured argument vector %j',
    async ({ args }) => {
      expect(
        await createPtyShellLaunchPlan(
          { ...base, shellOverride: '/bin/bash', terminalShellArgs: args },
          {}
        )
      ).toMatchObject({ shellPath: '/bin/bash', shellArgs: args })
    }
  )
  it.each([{ command: 'codex' }, { launchAgent: 'codex' as const }])(
    'keeps controlled login arguments for agent launches %o',
    async (overrides) => {
      expect(
        await createPtyShellLaunchPlan(
          {
            ...base,
            shellOverride: '/bin/zsh',
            terminalShellArgs: ['--rcfile', '/tmp/orca'],
            ...overrides
          },
          {}
        )
      ).toMatchObject({ shellArgs: ['-l'] })
    }
  )
})
