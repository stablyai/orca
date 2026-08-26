import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_BROWSER_IDLE_TIMEOUT_MS,
  createAgentBrowserProcessEnvironment
} from './agent-browser-process-environment'

vi.mock('node:fs', () => ({ mkdirSync: vi.fn(), chmodSync: vi.fn() }))

describe('agent-browser process environment', () => {
  it('bounds Unix socket paths independently of a long profile path', () => {
    const { env, ownsSocketDirectory } = createAgentBrowserProcessEnvironment({
      inheritedEnv: { PATH: '/bin' },
      platform: 'darwin',
      userDataPath: `/private/var/folders/${'long-profile-segment/'.repeat(12)}`
    })
    const socketDirectory = env.AGENT_BROWSER_SOCKET_DIR

    expect(ownsSocketDirectory).toBe(true)
    expect(socketDirectory).toMatch(/^\/tmp\/orca-ab-[0-9a-f]{16}$/)
    expect(
      `${socketDirectory}/orca-tab-00000000-0000-4000-8000-000000000000.sock`.length
    ).toBeLessThan(104)
  })

  // Why ownsSocketDirectory is false for both: a directory Orca did not derive can be shared with
  // another Orca profile, so `session list` under it is no proof of ownership.
  it('preserves explicit overrides and leaves Windows socket routing unchanged', () => {
    const configured = createAgentBrowserProcessEnvironment({
      inheritedEnv: { AGENT_BROWSER_SOCKET_DIR: '/custom/socket-dir' },
      platform: 'linux',
      userDataPath: '/profile'
    })
    expect(configured.env.AGENT_BROWSER_SOCKET_DIR).toBe('/custom/socket-dir')
    expect(configured.ownsSocketDirectory).toBe(false)

    const windows = createAgentBrowserProcessEnvironment({
      inheritedEnv: { PATH: 'C:\\Windows' },
      platform: 'win32',
      userDataPath: 'C:\\Users\\Orca'
    })
    expect(windows.env.AGENT_BROWSER_SOCKET_DIR).toBeUndefined()
    expect(windows.env.PATH).toBe('C:\\Windows')
    expect(windows.ownsSocketDirectory).toBe(false)
  })

  // Why: the only daemon bound that survives a SIGKILL'd Orca, so it must be set on every platform.
  it.each<NodeJS.Platform>(['darwin', 'linux', 'win32'])(
    'bounds daemon idle lifetime on %s',
    (platform) => {
      const { env } = createAgentBrowserProcessEnvironment({
        inheritedEnv: { PATH: '/bin' },
        platform,
        userDataPath: '/profile'
      })
      expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe(String(AGENT_BROWSER_IDLE_TIMEOUT_MS))
    }
  )

  it('never cuts a command short: idle timeout exceeds the bridge exec timeout', () => {
    expect(AGENT_BROWSER_IDLE_TIMEOUT_MS).toBeGreaterThan(90_000)
  })

  it('honors an explicit idle timeout from the environment', () => {
    const { env } = createAgentBrowserProcessEnvironment({
      inheritedEnv: { AGENT_BROWSER_IDLE_TIMEOUT_MS: '5000' },
      platform: 'darwin',
      userDataPath: '/profile'
    })
    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe('5000')
  })

  it('still bounds the daemon when the socket directory cannot be created', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.mkdirSync).mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const { env, ownsSocketDirectory } = createAgentBrowserProcessEnvironment({
      inheritedEnv: { PATH: '/bin' },
      platform: 'linux',
      userDataPath: '/profile'
    })
    expect(env.AGENT_BROWSER_SOCKET_DIR).toBeUndefined()
    expect(ownsSocketDirectory).toBe(false)
    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe(String(AGENT_BROWSER_IDLE_TIMEOUT_MS))
  })
})
