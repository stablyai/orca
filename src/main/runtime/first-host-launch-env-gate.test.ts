import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeAccountController } from './runtime-account-controller'
import type { HostAccountLaunchEnv } from '../../shared/host-account-launch-env'
import { FIRST_HOST_LAUNCH_ENV_WAIT_MS } from './first-host-launch-env-gate'

const PUSHED: HostAccountLaunchEnv = {
  wslDistro: 'Ubuntu',
  claude: { CLAUDE_CONFIG_DIR: '/home/u/.local/share/orca/claude-accounts/a/config' },
  terminal: { CODEX_HOME: '/home/u/.local/share/orca/codex-accounts/b/home' }
}

function freshWslHost(): RuntimeAccountController {
  const accounts = new RuntimeAccountController()
  accounts.restoreHostLaunchEnv(null, () => {}, { expectDesktopPush: true })
  return accounts
}

describe('first account push on a fresh WSL host', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds an immediate agent launch until the desktop pushes, then uses the pushed account', async () => {
    const accounts = freshWslHost()
    let launched = false
    const launch = accounts.prepareHostAgentLaunch(null).then(() => {
      launched = true
      return accounts.hostLaunchEnvFor('claude')
    })
    await Promise.resolve()
    expect(launched).toBe(false)

    accounts.setHostLaunchEnv(PUSHED)

    await expect(launch).resolves.toEqual(PUSHED.claude)
  })

  it('launches on the distro login after the wait, and later launches do not wait again', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const accounts = freshWslHost()

    const first = accounts.prepareHostAgentLaunch(null)
    await vi.advanceTimersByTimeAsync(FIRST_HOST_LAUNCH_ENV_WAIT_MS)
    await first
    expect(accounts.hostLaunchEnvFor('claude')).toEqual({})

    let second = false
    void accounts.prepareHostAgentLaunch(null).then(() => {
      second = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(second).toBe(true)
  })

  it('never waits on the desktop, with a saved env, or off a WSL host', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const desktop = new RuntimeAccountController()
    const saved = new RuntimeAccountController()
    saved.restoreHostLaunchEnv(PUSHED, () => {}, { expectDesktopPush: true })
    const other = new RuntimeAccountController()
    other.restoreHostLaunchEnv(null, () => {})

    for (const accounts of [desktop, saved, other]) {
      let done = false
      void accounts.prepareHostAgentLaunch('claude').then(() => {
        done = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(done).toBe(true)
    }
    expect(saved.hostLaunchEnvFor('claude')).toEqual(PUSHED.claude)
    expect(desktop.getCommitMessageAgentEnvironment()).toBeUndefined()
    expect(other.getCommitMessageAgentEnvironment()).toBeUndefined()
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('makes AI commit text wait for the push too', async () => {
    const accounts = freshWslHost()
    const resolvers = accounts.getCommitMessageAgentEnvironment()
    const claude = resolvers?.prepareForClaudeLaunch?.()
    const codex = resolvers?.prepareForCodexLaunch?.()

    accounts.setHostLaunchEnv(PUSHED)

    await expect(claude).resolves.toMatchObject({
      configDir: PUSHED.claude.CLAUDE_CONFIG_DIR,
      envPatch: PUSHED.claude
    })
    await expect(codex).resolves.toBe(PUSHED.terminal.CODEX_HOME)
  })
})
