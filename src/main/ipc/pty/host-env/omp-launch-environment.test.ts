import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inheritOmpLaunchEnvironment } from './omp-launch-environment'
import { resolveLoginShellEnvironment } from '../../../startup/login-shell-environment'

vi.mock('../../../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: vi.fn()
}))

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', env: {} })
  vi.mocked(resolveLoginShellEnvironment).mockReset().mockResolvedValue({
    XDG_DATA_HOME: '/login/data',
    XDG_STATE_HOME: '/login/state',
    XDG_CACHE_HOME: '/login/cache',
    PI_CONFIG_DIR: '.config/omp',
    PI_CODING_AGENT_DIR: '/pi/override',
    UNRELATED: 'ignore'
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('OMP launch directory environment', () => {
  it.each([{ launchAgent: 'omp' }, { launchCommand: 'omp' }, {}])(
    'inherits login-shell category roots for %j',
    async (options) => {
      const env = {}
      await inheritOmpLaunchEnvironment(env, options)
      expect(env).toEqual({
        XDG_DATA_HOME: '/login/data',
        XDG_STATE_HOME: '/login/state',
        XDG_CACHE_HOME: '/login/cache',
        PI_CONFIG_DIR: '.config/omp'
      })
    }
  )

  it('uses the same login roots for merged local env and daemon pane deltas', async () => {
    const local = { XDG_DATA_HOME: '/old/data', PI_CONFIG_DIR: '.old-omp' }
    const daemon = {}
    await inheritOmpLaunchEnvironment(local, { launchAgent: 'omp', explicitEnv: {} })
    await inheritOmpLaunchEnvironment(daemon, { launchAgent: 'omp' })
    expect(local).toEqual(daemon)
    expect(local.XDG_DATA_HOME).toBe('/login/data')
    const overridden = { XDG_DATA_HOME: '/old/data' }
    await inheritOmpLaunchEnvironment(overridden, {
      launchAgent: 'omp',
      explicitEnv: { XDG_DATA_HOME: '/pane/data' }
    })
    expect(overridden.XDG_DATA_HOME).toBe('/pane/data')
  })

  it('preserves explicit pane roots and intentionally empty XDG values', async () => {
    const env = { XDG_DATA_HOME: '/pane/data', XDG_STATE_HOME: '' }
    await inheritOmpLaunchEnvironment(env, { launchAgent: 'omp' })
    expect(env.XDG_DATA_HOME).toBe('/pane/data')
    expect(env.XDG_STATE_HOME).toBe('')
  })

  it('keeps an explicitly empty OMP root at the default through profile fallback', async () => {
    const env = { PI_CONFIG_DIR: '' }
    await inheritOmpLaunchEnvironment(env, { launchAgent: 'omp' })
    expect(env.PI_CONFIG_DIR).toBe('.omp')
  })

  it.each([
    { isWsl: true, launchAgent: 'omp' },
    { launchAgent: 'pi' },
    { launchAgent: 'claude' },
    { launchCommand: 'pi' },
    { launchCommand: 'npm test' }
  ])('does not probe a different execution environment for %j', async (options) => {
    const env = {}
    await inheritOmpLaunchEnvironment(env, options)
    expect(env).toEqual({})
    expect(resolveLoginShellEnvironment).not.toHaveBeenCalled()
  })

  it('imports explicit WSL roots without importing ambient Windows roots', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const env = { PI_CONFIG_DIR: '.host-root', XDG_DATA_HOME: 'C:/host/data', WSLENV: 'KEEP/u' }
    await inheritOmpLaunchEnvironment(env, {
      isWsl: true,
      launchAgent: 'omp',
      explicitEnv: { PI_CONFIG_DIR: '.guest-root', XDG_CACHE_HOME: '/tmp/guest-cache' }
    })
    expect(env.PI_CONFIG_DIR).toBe('.guest-root')
    expect(env.WSLENV.split(':')).toEqual(['KEEP/u', 'XDG_CACHE_HOME', 'PI_CONFIG_DIR'])
    expect(resolveLoginShellEnvironment).not.toHaveBeenCalled()
  })

  it('canonicalizes an explicitly empty WSL config root to the OMP default', async () => {
    const env = { PI_CONFIG_DIR: '' }
    await inheritOmpLaunchEnvironment(env, { isWsl: true, launchAgent: 'omp' })
    expect(env).toEqual({ PI_CONFIG_DIR: '.omp', WSLENV: 'PI_CONFIG_DIR' })
    expect(resolveLoginShellEnvironment).not.toHaveBeenCalled()
  })

  it('does not import POSIX roots into native Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    await inheritOmpLaunchEnvironment({}, { launchAgent: 'omp' })
    expect(resolveLoginShellEnvironment).not.toHaveBeenCalled()
  })
})
