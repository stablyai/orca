import { describe, expect, it, vi } from 'vitest'
import { createAgentBrowserProcessEnvironment } from './agent-browser-process-environment'

vi.mock('node:fs', () => ({ mkdirSync: vi.fn(), chmodSync: vi.fn() }))

describe('agent-browser process environment', () => {
  it('bounds Unix socket paths independently of a long profile path', () => {
    const env = createAgentBrowserProcessEnvironment({
      inheritedEnv: { PATH: '/bin' },
      platform: 'darwin',
      userDataPath: `/private/var/folders/${'long-profile-segment/'.repeat(12)}`
    })
    const socketDirectory = env.AGENT_BROWSER_SOCKET_DIR

    expect(socketDirectory).toMatch(/^\/tmp\/orca-ab-[0-9a-f]{16}$/)
    expect(
      `${socketDirectory}/orca-tab-00000000-0000-4000-8000-000000000000.sock`.length
    ).toBeLessThan(104)
  })

  it('preserves explicit overrides and leaves Windows unchanged', () => {
    const configured = { AGENT_BROWSER_SOCKET_DIR: '/custom/socket-dir' }
    expect(
      createAgentBrowserProcessEnvironment({
        inheritedEnv: configured,
        platform: 'linux',
        userDataPath: '/profile'
      })
    ).toBe(configured)

    const windows = { PATH: 'C:\\Windows' }
    expect(
      createAgentBrowserProcessEnvironment({
        inheritedEnv: windows,
        platform: 'win32',
        userDataPath: 'C:\\Users\\Orca'
      })
    ).toBe(windows)
  })
})
