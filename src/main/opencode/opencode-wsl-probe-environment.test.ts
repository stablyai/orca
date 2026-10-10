import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareOpenCodePtyLaunch } from './opencode-pty-launch'
import { seedWslGuestEnvironmentForTests } from '../wsl/wsl-guest-environment'

const run = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: run }))
vi.mock('../wsl/wsl-executable-path', () => ({ resolveWslExecutablePath: () => 'wsl.exe' }))
vi.mock('../agent-hooks/server', () => ({ agentHookServer: { endpointFilePath: null } }))

beforeEach(() => {
  run.mockReset().mockResolvedValue({ code: 0, stdout: '2.0.16', timedOut: false })
  seedWslGuestEnvironmentForTests('probe-deletion', {
    path: '/usr/bin',
    home: '/private/guest',
    envBinary: '/usr/bin/env'
  })
  vi.stubEnv('DELETED_CREDENTIAL', 'dummy-host-value')
  vi.stubEnv('OPENCODE_CONFIG_DIR', 'C:\\dummy\\config')
  vi.stubEnv('KEEP', 'C:\\keep')
  vi.stubEnv('EMPTY', '')
  vi.stubEnv('WSLENV', 'DELETED_CREDENTIAL/u:OPENCODE_CONFIG_DIR/p:KEEP/p:EMPTY/u')
})
afterEach(() => vi.unstubAllEnvs())

describe('OpenCode WSL version-probe deletion boundary', () => {
  it.each([
    { deleted: ['DELETED_CREDENTIAL', 'OPENCODE_CONFIG_DIR'], kept: ['KEEP/p', 'EMPTY/u'] },
    { deleted: ['WSLENV'], kept: [] }
  ])(
    'does not restore deleted keys through the inherited carrier: $deleted',
    async ({ deleted, kept }) => {
      await prepareOpenCodePtyLaunch({
        command: 'opencode',
        env: {},
        envToDelete: [...deleted],
        isFreshLaunch: true,
        wsl: { distro: 'probe-deletion' },
        cwd: `/private/${deleted.join('-')}`
      })
      const hostEnv = run.mock.calls[0]?.[0].env
      expect(hostEnv).toBeDefined()
      const tokens = String(hostEnv.WSLENV).split(':').filter(Boolean)
      expect(tokens).not.toContain('DELETED_CREDENTIAL/u')
      expect(tokens).not.toContain('OPENCODE_CONFIG_DIR/p')
      expect(tokens).toEqual(expect.arrayContaining(kept))
      // The host value may exist; its carrier must not import it into the guest.
      expect(hostEnv.DELETED_CREDENTIAL).toBe('dummy-host-value')
    }
  )

  it('shares a sanitized concurrent probe without losing kept flags or empty values', async () => {
    const options = {
      command: 'opencode',
      env: {},
      envToDelete: ['DELETED_CREDENTIAL', 'OPENCODE_CONFIG_DIR'],
      isFreshLaunch: true,
      wsl: { distro: 'probe-deletion' },
      cwd: '/private/concurrent'
    }
    await Promise.all([
      prepareOpenCodePtyLaunch({ ...options, envToDelete: [...options.envToDelete] }),
      prepareOpenCodePtyLaunch({ ...options, envToDelete: [...options.envToDelete] })
    ])
    expect(run).toHaveBeenCalledTimes(1)
    const hostEnv = run.mock.calls[0]?.[0].env
    expect(hostEnv.WSLENV).toContain('KEEP/p')
    expect(hostEnv.WSLENV).toContain('EMPTY/u')
    expect(hostEnv.WSLENV).not.toContain('DELETED_CREDENTIAL')
    expect(hostEnv.WSLENV).not.toContain('OPENCODE_CONFIG_DIR')
    expect(hostEnv.EMPTY).toBe('')
  })
})
