import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAccountLaunchEnv } from '../../shared/host-account-launch-env'
import { wslClaudeProfile } from '../claude-accounts/claude-profile-wsl-paths'
import { provisionWslClaudeAccountProfile } from '../claude-accounts/claude-profile-wsl-provision'
import { RuntimeAccountController } from '../runtime/runtime-account-controller'
import { createWslHostClaudeProfileRefresh } from './orcad-wsl-host-claude-profile-refresh'

const DISTRO = 'orca-acct-test'
const ACCOUNT = 'acct-1'
const dirs: string[] = []

function guestHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-claude-refresh-'))
  dirs.push(dir)
  return dir
}

function launchEnvFor(home: string, accountId = ACCOUNT): HostAccountLaunchEnv {
  const { profile } = wslClaudeProfile(home, DISTRO, accountId)
  return {
    wslDistro: DISTRO,
    claude: { CLAUDE_CONFIG_DIR: profile.home },
    terminal: {}
  }
}

/** The folder the desktop's guest helper set up when the account was added. */
async function setUpAccountFolder(home: string): Promise<string> {
  const report = await provisionWslClaudeAccountProfile(home, DISTRO, ACCOUNT)
  expect(report.outcome).toBe('prepared')
  return wslClaudeProfile(home, DISTRO, ACCOUNT).profile.home
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('WSL host Claude folder refresh', () => {
  it("carries the distro user's onboarding, theme and settings into the account folder, never their login", async () => {
    const home = guestHome()
    const accountHome = await setUpAccountFolder(home)
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: 'dark',
        bypassPermissionsModeAccepted: true,
        oauthAccount: { emailAddress: 'distro-user@example.invalid' },
        userID: 'distro-user-id'
      })
    )
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }))

    await createWslHostClaudeProfileRefresh({ userHome: home })(launchEnvFor(home))

    const state = JSON.parse(readFileSync(join(accountHome, '.claude.json'), 'utf8'))
    expect(state).toMatchObject({
      hasCompletedOnboarding: true,
      theme: 'dark',
      bypassPermissionsModeAccepted: true
    })
    expect(state.oauthAccount).toBeUndefined()
    expect(state.userID).toBeUndefined()
    expect(JSON.parse(readFileSync(join(accountHome, 'settings.json'), 'utf8'))).toMatchObject({
      model: 'opus'
    })
  })

  it('leaves alone a folder the desktop never set up, and any path that is not its own', async () => {
    const home = guestHome()
    const provision = vi.fn()
    const refresh = createWslHostClaudeProfileRefresh({ userHome: home, provision })

    await refresh(launchEnvFor(home))
    await setUpAccountFolder(home)
    await refresh({
      wslDistro: DISTRO,
      claude: { CLAUDE_CONFIG_DIR: '/etc/acct-1/home' },
      terminal: {}
    })
    await refresh({ wslDistro: DISTRO, claude: {}, terminal: {} })
    // An id that is not an Orca account id is skipped, never a failed launch.
    await refresh({
      wslDistro: DISTRO,
      claude: { CLAUDE_CONFIG_DIR: '/home/u/my.profile/home' },
      terminal: {}
    })

    expect(provision).not.toHaveBeenCalled()
  })

  it('caps the wait and never fails the launch', async () => {
    const home = guestHome()
    await setUpAccountFolder(home)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hung = createWslHostClaudeProfileRefresh({
      userHome: home,
      provision: () => new Promise(() => {}),
      waitMs: 10
    })
    await expect(hung(launchEnvFor(home))).resolves.toBeUndefined()

    const failing = createWslHostClaudeProfileRefresh({
      userHome: home,
      provision: () => Promise.reject(new Error('disk full'))
    })
    await expect(failing(launchEnvFor(home))).resolves.toBeUndefined()
  })

  it('refreshes the newly selected account when the desktop switches during a refresh', async () => {
    const home = guestHome()
    const refreshed: string[] = []
    const accounts = new RuntimeAccountController()
    const switched = launchEnvFor(home, 'acct-2')
    accounts.restoreHostLaunchEnv(launchEnvFor(home), () => {}, {
      refreshClaudeProfile: async (launchEnv) => {
        refreshed.push(launchEnv.claude.CLAUDE_CONFIG_DIR ?? '')
        if (refreshed.length === 1) {
          accounts.setHostLaunchEnv(switched)
        }
      }
    })

    await accounts.prepareHostAgentLaunch('claude')

    expect(refreshed).toEqual([
      launchEnvFor(home).claude.CLAUDE_CONFIG_DIR,
      switched.claude.CLAUDE_CONFIG_DIR
    ])
  })
})
