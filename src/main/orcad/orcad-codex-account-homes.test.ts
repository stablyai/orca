import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getDefaultSettings } from '../../shared/constants'

vi.mock('../codex/codex-launch-home', () => ({
  resolveCodexLaunchHome: launchHome
}))

const { prepareHooks, resolveHome, listHomes, launchHome } = vi.hoisted(() => ({
  prepareHooks: vi.fn(
    async (_home: string, _isHooksEnabled: () => boolean, _launchesCodex: boolean) => {}
  ),
  resolveHome: vi.fn((candidate: string | undefined): string | null =>
    candidate === '/home/u/.local/share/orca/codex-accounts/a1/home' ? candidate : null
  ),
  listHomes: vi.fn(() => ['/home/u/.local/share/orca/codex-accounts/a1/home']),
  launchHome: vi.fn(
    ({ selectedAccount }: { selectedAccount: { homePath: string } }) =>
      `${selectedAccount.homePath}/overlay`
  )
}))

const wslHost = vi.hoisted(() => vi.fn(() => false))
vi.mock('../ipc/wsl-guest-windows-drive-path', () => ({ isWslHostOrcadProcess: wslHost }))
vi.mock('../codex/codex-account-home-hook', () => ({
  reconcileCodexAccountHomeHook: prepareHooks
}))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  stopCodexStateDbBackfillRecoveries: vi.fn(async () => {})
}))
vi.mock('../codex-accounts/guest-codex-account-homes', () => ({
  resolveGuestCodexAccountHome: resolveHome,
  listGuestCodexAccountHomes: listHomes
}))

import { orcadCodexAccountHomes } from './orcad-codex-account-homes'

const noCleanup = (): void => {}
const ACCOUNT_HOME = '/home/u/.local/share/orca/codex-accounts/a1/home'

function settings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return {
    ...getDefaultSettings('/home/u'),
    agentStatusHooksEnabled: true,
    ...overrides
  }
}

describe('orcadCodexAccountHomes', () => {
  beforeEach(() => {
    prepareHooks.mockClear()
    launchHome.mockClear()
    wslHost.mockReturnValue(false)
  })

  it('on a WSL host with hooks off, leaves the bridge-shared entry alone', async () => {
    wslHost.mockReturnValue(true)
    const homes = orcadCodexAccountHomes(
      () => settings({ agentStatusHooksEnabled: false }),
      noCleanup
    )
    await expect(homes.selectLaunchHome(undefined, { CODEX_HOME: ACCOUNT_HOME })).resolves.toBe(
      ACCOUNT_HOME
    )
    expect(prepareHooks).not.toHaveBeenCalled()
    wslHost.mockReturnValue(false)
  })

  it('puts the hook into a client-sent account home and launches on it', async () => {
    const homes = orcadCodexAccountHomes(() => settings({}), noCleanup)
    await expect(
      homes.selectLaunchHome(
        { runtime: 'host' },
        { CODEX_HOME: ACCOUNT_HOME },
        { launchesCodex: true }
      )
    ).resolves.toBe(`${ACCOUNT_HOME}/overlay`)
    expect(prepareHooks).toHaveBeenCalledWith(`${ACCOUNT_HOME}/overlay`, expect.any(Function), true)
  })

  it('reads the hook switch live, so turning hooks off takes the entry out', async () => {
    let current = settings({})
    const homes = orcadCodexAccountHomes(() => current, noCleanup)
    await homes.selectLaunchHome(undefined, { CODEX_HOME: ACCOUNT_HOME })
    const isEnabled = prepareHooks.mock.calls[0]?.[1]
    expect(isEnabled?.()).toBe(true)
    current = settings({ agentStatusHooksEnabled: false })
    expect(isEnabled?.()).toBe(false)
    expect(prepareHooks.mock.calls[0]?.[2]).toBe(false)
  })

  it('preserves an existing overlay store across guest reads and launches', async () => {
    const overlay = `/home/u/.local/share/orca/codex-accounts/a1/overlays/${'a'.repeat(32)}`
    const homes = orcadCodexAccountHomes(() => settings({}), noCleanup)
    resolveHome.mockReturnValueOnce(overlay)
    homes.readLaunchHome({ CODEX_HOME: overlay })
    expect(launchHome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedAccount: { homePath: ACCOUNT_HOME },
        conversationHome: overlay,
        readOnly: true
      })
    )
    resolveHome.mockReturnValueOnce(overlay)
    await homes.selectLaunchHome(undefined, { CODEX_HOME: overlay })
    expect(launchHome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedAccount: { homePath: ACCOUNT_HOME },
        conversationHome: overlay,
        readOnly: false
      })
    )
  })

  it('leaves a launch without an Orca account home alone', async () => {
    const homes = orcadCodexAccountHomes(() => settings({}), noCleanup)
    await expect(
      homes.selectLaunchHome(undefined, { CODEX_HOME: '/home/u/my-codex' })
    ).resolves.toBe(null)
    await expect(homes.selectLaunchHome(undefined, {})).resolves.toBe(null)
    await expect(homes.selectLaunchHome()).resolves.toBe(null)
    expect(prepareHooks).not.toHaveBeenCalled()
  })

  it('preserves the desktop-prepared WSL route for reads and actual PTY launch', async () => {
    wslHost.mockReturnValue(true)
    const homes = orcadCodexAccountHomes(() => settings({}), noCleanup)
    expect(homes.readLaunchHome({ CODEX_HOME: ACCOUNT_HOME })).toBe(ACCOUNT_HOME)
    await expect(
      homes.selectLaunchHome(
        undefined,
        { CODEX_HOME: ACCOUNT_HOME },
        {
          launchesCodex: true,
          conversationHome: '/desktop/chosen/source'
        }
      )
    ).resolves.toBe(ACCOUNT_HOME)
    expect(prepareHooks).toHaveBeenCalledWith(ACCOUNT_HOME, expect.any(Function), true)
    expect(launchHome).not.toHaveBeenCalled()
  })

  it('lists the account homes for session discovery', () => {
    expect(orcadCodexAccountHomes(() => settings({}), noCleanup).listSessionHomes()).toEqual([
      ACCOUNT_HOME
    ])
  })
})
