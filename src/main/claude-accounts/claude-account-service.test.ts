import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

import type { ClaudeCommandConfig, ClaudeCommandOptions } from './sign-in/claude-command-process'

import type { ClaudeAccountSelectionTarget } from './selection/runtime-selection'
import { ClaudeAccountService } from './service'

// Selection checks must never reach the real Keychain.
vi.mock('../macos-keychain/generic-password', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readKeychainPassword: async () => null
}))

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function account(id: string, extra: Partial<ClaudeManagedAccount> = {}): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.test`,
    managedAuthPath: '',
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...extra
  }
}

function fixture(accounts: ClaudeManagedAccount[] = [account('a'), account('b')]) {
  const root = mkdtempSync(join(tmpdir(), 'claude-accounts-'))
  roots.push(root)
  const home = (id: string) => join(root, id, 'home')
  const signIn = (id: string, email: string, organizationUuid?: string) => {
    mkdirSync(home(id), { recursive: true })
    writeFileSync(
      join(home(id), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid } })
    )
  }
  const covered = new Set<string>()
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: {} }
  }
  const runtimeAuth = {
    router: {
      accountHome: home,
      userConfigDir: () => join(root, 'personal'),
      systemDefaultHome: () => join(root, 'personal'),
      copiedLoginIntoSystemDefault: () => existsSync(join(root, 'claude-runtime-auth')),
      coveredBySystemDefault: (id: string) => covered.has(id)
    },
    syncForCurrentSelection: vi.fn(async (_target?: ClaudeAccountSelectionTarget) => {}),
    publishAll: vi.fn(async () => {}),
    prepareAccountFolder: vi.fn(async (id: string) => {
      mkdirSync(home(id), { recursive: true })
      return { configDir: home(id), readPath: home(id) }
    }),
    removeAccountFolder: vi.fn(async (id: string) => rmSync(join(root, id), { recursive: true })),
    getRuntimeConfigDir: () => '/unused'
  }
  const runLogin = vi.fn<
    (
      args: string[],
      config: ClaudeCommandConfig,
      timeoutMs: number,
      options?: ClaudeCommandOptions
    ) => Promise<string>
  >(async () => '')
  const service = new ClaudeAccountService(
    {
      getSettings: () => settings,
      updateSettings: (patch) => {
        settings = { ...settings, ...patch }
      }
    },
    {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
    },
    runtimeAuth,
    runLogin
  )
  return { root, home, service, runtimeAuth, runLogin, signIn, covered, settings: () => settings }
}

function newId(f: ReturnType<typeof fixture>): string {
  return f.runtimeAuth.prepareAccountFolder.mock.calls.at(-1)![0]
}

// Publish atomically so the poller cannot read an empty link.
function handOverClaudeSignInLink(windowsPath: string, link: string): void {
  const helperPath = join(windowsPath, '.orca-sign-in-browser')
  writeFileSync(`${helperPath}.tmp`, link)
  renameSync(`${helperPath}.tmp`, `${helperPath}.link`)
}

describe('ClaudeAccountService', () => {
  it.each([
    { savedEmail: 'old@example.test', currentEmail: 'current@example.test' },
    { savedEmail: 'same@example.test', currentEmail: 'same@example.test' }
  ])(
    'checks the listed identity after a folder changes from $savedEmail',
    async ({ savedEmail, currentEmail }) => {
      const f = fixture([account('a', { email: savedEmail, organizationUuid: 'old-org' })])
      f.signIn('a', currentEmail, 'current-org')
      expect(f.service.listAccounts().accounts[0]).toMatchObject({
        email: currentEmail,
        organizationUuid: 'current-org'
      })

      const original = await f.service.beginSignIn({ runtime: 'host' })
      f.signIn(original.accountId, savedEmail, 'old-org')
      await expect(f.service.finishSignIn(original)).resolves.toMatchObject({
        accounts: expect.arrayContaining([
          expect.objectContaining({ id: original.accountId, email: savedEmail })
        ])
      })

      const duplicate = await f.service.beginSignIn({ runtime: 'host' })
      f.signIn(duplicate.accountId, currentEmail, 'current-org')
      await expect(f.service.finishSignIn(duplicate)).rejects.toThrow('already added')
      expect(existsSync(join(f.root, duplicate.accountId))).toBe(false)
      expect(f.service.listAccounts().accounts).toHaveLength(2)
      expect(existsSync(f.home('a'))).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'hands the link Claude gives BROWSER to Settings when asked to copy it',
    async () => {
      const LINK =
        'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback'
      const f = fixture()
      let copied: string | null = null
      f.runLogin.mockImplementationOnce(async (_args, config) => {
        handOverClaudeSignInLink(config.windowsPath, LINK)
        await vi.waitFor(() => expect(copied).toBe(LINK))
        f.signIn(newId(f), 'new@example.test')
        return ''
      })
      const adding = f.service.addAccount({ runtime: 'host' }, true)
      copied = await f.service.waitForSignInLink()
      await adding
      expect(existsSync(join(f.home(newId(f)), '.orca-sign-in-browser'))).toBe(false)
      await expect(f.service.waitForSignInLink()).resolves.toBeNull()
    }
  )

  it('leaves no row or folder when the hidden login is cancelled', async () => {
    const f = fixture()
    f.runLogin.mockImplementationOnce(
      (_args, _config, _timeoutMs, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () =>
            reject(new Error('Claude sign-in was cancelled.'))
          )
        )
    )
    const adding = f.service.addAccount({ runtime: 'host' })
    await vi.waitFor(() => expect(f.runLogin).toHaveBeenCalled())
    expect(f.service.cancelPendingLogin()).toBe(true)
    await expect(adding).rejects.toThrow('Claude sign-in was cancelled.')
    expect(f.service.cancelPendingLogin()).toBe(false)
    expect(f.settings().claudeManagedAccounts).toHaveLength(2)
    expect(f.runtimeAuth.removeAccountFolder).toHaveBeenCalledWith(newId(f), { runtime: 'host' })
    expect(existsSync(join(f.root, newId(f)))).toBe(false)
  })

  it('names a signed-out account without touching its sign-in, keeps the name, and drops it on removal', async () => {
    const f = fixture()
    const records = f.settings().claudeManagedAccounts
    const selection = f.settings().activeClaudeManagedAccountIdsByRuntime
    expect(f.service.renameAccount('b', '  Work  ').accounts).toContainEqual(
      expect.objectContaining({ id: 'b', email: 'b@example.test', displayName: 'Work' })
    )
    // Launch-relevant records and selection stay the same objects, so nothing re-reads them.
    expect(f.settings().claudeManagedAccounts).toBe(records)
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime).toBe(selection)
    f.runLogin.mockImplementationOnce(async () => {
      f.signIn('b', 'b@example.test')
      return ''
    })
    await f.service.reauthenticateAccount('b')
    expect(f.service.listAccounts().accounts.find((entry) => entry.id === 'b')?.displayName).toBe(
      'Work'
    )
    f.service.renameAccount('b', ' ')
    expect(f.settings().managedAccountDisplayNames).toEqual({ claude: {} })
    f.service.renameAccount('b', 'Work')
    await f.service.removeAccount('b')
    expect(f.settings().managedAccountDisplayNames).toEqual({ claude: {} })
  })

  it('signs a saved account in again inside its own folder and keeps it on failure', async () => {
    const f = fixture()
    f.runLogin.mockImplementationOnce(async (_args, config) => {
      expect(config.windowsPath).toBe(f.home('b'))
      f.signIn('b', 'b@example.test')
      return ''
    })
    await f.service.reauthenticateAccount('b')
    expect(f.runtimeAuth.prepareAccountFolder).toHaveBeenCalledWith('b', { runtime: 'host' })
    expect(f.settings().claudeManagedAccounts.find((entry) => entry.id === 'b')).toMatchObject({
      email: 'b@example.test',
      createdAt: 1
    })
    f.runLogin.mockRejectedValueOnce(new Error('Claude sign-in was cancelled.'))
    await expect(f.service.reauthenticateAccount('b')).rejects.toThrow('cancelled')
    expect(f.runtimeAuth.removeAccountFolder).not.toHaveBeenCalled()
    expect(f.settings().claudeManagedAccounts.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('refuses to select an account that has its identity but no login to start Claude with', async () => {
    const f = fixture()
    f.signIn('b', 'b@example.test')
    await expect(f.service.selectAccount('b')).rejects.toThrow(
      'Sign in to this Claude account again before selecting it.'
    )
    expect(f.settings().activeClaudeManagedAccountId).toBe('a')

    writeFileSync(
      join(f.home('b'), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh' } })
    )
    await expect(f.service.selectAccount('b')).resolves.toMatchObject({ activeAccountId: 'b' })
  })
})
