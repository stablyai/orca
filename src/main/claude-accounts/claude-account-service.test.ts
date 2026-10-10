import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE } from './claude-account-registration'
import {
  CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE,
  CLAUDE_ACCOUNT_NEEDS_SIGN_IN_MESSAGE
} from './claude-account-selection'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import { ClaudeAccountService } from './service'

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
  // Stands in for Claude finishing `claude auth login` in a folder.
  const signIn = (id: string, email: string) => {
    mkdirSync(home(id), { recursive: true })
    writeFileSync(
      join(home(id), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } })
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
  // Stands in for the hidden `claude auth login`; each test decides how it ends.
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

// The id the last sign-in prepared a folder for.
function newId(f: ReturnType<typeof fixture>): string {
  return f.runtimeAuth.prepareAccountFolder.mock.calls.at(-1)![0]
}

describe('ClaudeAccountService', () => {
  it("labels each row with its folder's login and asks a folder without one to sign in", () => {
    const f = fixture([
      account('a'),
      account('b'),
      account('old-wsl', {
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxAuthPath: '/home/u/.local/share/orca/claude-accounts/old-wsl/auth'
      }),
      account('new-wsl', {
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxAuthPath: '/home/u/.local/share/orca/claude-profiles/new-wsl/home'
      })
    ])
    f.signIn('a', 'now-a@example.test')
    const byId = new Map(f.service.listAccounts().accounts.map((row) => [row.id, row]))
    expect(byId.get('a')).toMatchObject({ email: 'now-a@example.test' })
    expect(byId.get('a')?.needsSignIn).toBeUndefined()
    expect(byId.get('b')).toMatchObject({ email: 'b@example.test', needsSignIn: true })
    expect(byId.get('old-wsl')).toMatchObject({ needsSignIn: true })
    expect(byId.get('new-wsl')?.needsSignIn).toBeUndefined()
  })

  it('asks no sign-in of an account System default runs, and lets it be selected', async () => {
    const f = fixture()
    f.covered.add('b')
    expect(f.service.listAccounts().accounts.find((row) => row.id === 'b')?.needsSignIn).toBe(
      undefined
    )
    await expect(f.service.selectAccount('b')).resolves.toMatchObject({ activeAccountId: 'b' })
  })

  it("reports System default's login from the user's own folder", () => {
    const f = fixture()
    mkdirSync(join(f.root, 'personal'))
    writeFileSync(
      join(f.root, 'personal', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.test' } })
    )
    expect(f.service.listAccounts()).toMatchObject({
      systemDefaultEmail: 'me@example.test'
    })
    expect(f.service.listAccounts()).not.toHaveProperty('userClaudeConfigDir')
    expect(f.service.listAccounts().systemDefaultMayBeCopied).toBeUndefined()
    mkdirSync(join(f.root, 'claude-runtime-auth'))
    expect(f.service.listAccounts().systemDefaultMayBeCopied).toBe(true)
  })

  it('saves an account only once its folder holds a login', async () => {
    const f = fixture()
    const begun = await f.service.beginSignIn({ runtime: 'host' })
    expect(begun).toMatchObject({
      runtime: 'host',
      configDir: join(f.root, begun.accountId, 'home')
    })
    await expect(f.service.finishSignIn(begun)).rejects.toThrow(CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE)
    expect(f.settings().claudeManagedAccounts).toHaveLength(2)

    f.signIn(begun.accountId, 'new@example.test')
    await f.service.finishSignIn(begun)
    expect(f.settings().claudeManagedAccounts.at(-1)).toMatchObject({
      id: begun.accountId,
      email: 'new@example.test',
      managedAuthPath: begun.configDir
    })
  })

  it('refuses a second account for the same login and deletes its folder', async () => {
    const f = fixture()
    const begun = await f.service.beginSignIn({ runtime: 'host' })
    f.signIn(begun.accountId, 'B@example.test')
    await expect(f.service.finishSignIn(begun)).rejects.toThrow('already added')
    expect(f.runtimeAuth.removeAccountFolder).toHaveBeenCalledWith(begun.accountId, {
      runtime: 'host'
    })
    expect(f.settings().claudeManagedAccounts).toHaveLength(2)
  })

  it('relabels a saved account signed in again under another login', async () => {
    const f = fixture()
    const begun = await f.service.beginSignIn({ accountId: 'b' })
    f.signIn('b', 'other@example.test')
    await f.service.finishSignIn(begun)
    expect(f.settings().claudeManagedAccounts.find((entry) => entry.id === 'b')).toMatchObject({
      email: 'other@example.test',
      createdAt: 1
    })
  })

  it('signs in with a hidden login straight into the new account folder', async () => {
    const f = fixture()
    f.runLogin.mockImplementationOnce(async (_args, config) => {
      f.signIn(newId(f), 'new@example.test')
      expect(config).toEqual({ windowsPath: f.home(newId(f)), linuxPath: null, wslDistro: null })
      return ''
    })
    await f.service.addAccount({ runtime: 'host' })
    expect(f.runLogin).toHaveBeenCalledWith(
      ['auth', 'login', '--claudeai'],
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({ keepStdinOpen: true })
    )
    expect(f.settings().claudeManagedAccounts.at(-1)).toMatchObject({
      id: newId(f),
      email: 'new@example.test',
      managedAuthPath: f.home(newId(f))
    })
    expect(f.runtimeAuth.removeAccountFolder).not.toHaveBeenCalled()
  })

  it('lets Claude open the browser itself for a plain sign-in', async () => {
    const f = fixture()
    f.runLogin.mockImplementationOnce(async (_args, config, _timeoutMs, options) => {
      expect(options?.browser).toBeUndefined()
      expect(existsSync(join(config.windowsPath, '.orca-sign-in-browser'))).toBe(false)
      f.signIn(newId(f), 'new@example.test')
      return ''
    })
    await f.service.addAccount({ runtime: 'host' })
    expect(f.runLogin).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')(
    'hands the link Claude gives BROWSER to Settings when asked to copy it',
    async () => {
      const LINK =
        'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback'
      const f = fixture()
      let copied: string | null = null
      f.runLogin.mockImplementationOnce(async (_args, _config, _timeoutMs, options) => {
        // Stands in for Claude running BROWSER, then finishing once the browser signs in.
        writeFileSync(`${options!.browser}.link`, LINK)
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

  it('fails a copy-link sign-in it cannot catch, rather than opening a browser', async () => {
    const f = fixture()
    // A folder that does not exist: the BROWSER stand-in cannot be written there.
    f.runtimeAuth.prepareAccountFolder.mockImplementationOnce(async (id: string) => ({
      configDir: join(f.root, id, 'missing'),
      readPath: join(f.root, id, 'missing')
    }))
    const adding = f.service.addAccount({ runtime: 'host' }, true)
    await expect(f.service.waitForSignInLink()).resolves.toBeNull()
    await expect(adding).rejects.toThrow('Claude sign-in failed. Please try again.')
    expect(f.runLogin).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'ends a copy-link sign-in when Claude hands BROWSER something other than a sign-in link',
    async () => {
      const f = fixture()
      f.runLogin.mockImplementationOnce(
        (_args, _config, _timeoutMs, options) =>
          new Promise((_resolve, reject) => {
            writeFileSync(`${options!.browser}.link`, 'https://example.test/not-a-sign-in')
            options?.signal?.addEventListener('abort', () =>
              reject(new Error('Claude sign-in was cancelled.'))
            )
          })
      )
      const adding = f.service.addAccount({ runtime: 'host' }, true)
      await expect(f.service.waitForSignInLink()).resolves.toBeNull()
      await expect(adding).rejects.toThrow('Claude sign-in failed. Please try again.')
    }
  )

  it('reports no link when a copy-link sign-in ends before Claude hands one over', async () => {
    const f = fixture()
    f.runLogin.mockRejectedValueOnce(new Error('Claude sign-in was cancelled.'))
    const adding = f.service.reauthenticateAccount('b', true)
    await expect(f.service.waitForSignInLink()).resolves.toBeNull()
    await expect(adding).rejects.toThrow('cancelled')
  })

  it('runs a WSL login against the guest folder', async () => {
    const f = fixture()
    f.runtimeAuth.prepareAccountFolder.mockImplementation(async (id: string) => {
      mkdirSync(f.home(id), { recursive: true })
      return { configDir: `/home/u/claude-profiles/${id}/home`, readPath: f.home(id) }
    })
    f.runLogin.mockImplementationOnce(async (_args, config) => {
      f.signIn(newId(f), 'wsl@example.test')
      expect(config).toEqual({
        windowsPath: f.home(newId(f)),
        linuxPath: `/home/u/claude-profiles/${newId(f)}/home`,
        wslDistro: 'Ubuntu'
      })
      return ''
    })
    await f.service.addAccount({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(f.settings().claudeManagedAccounts.at(-1)).toMatchObject({
      email: 'wsl@example.test',
      managedAuthRuntime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxAuthPath: `/home/u/claude-profiles/${newId(f)}/home`
    })
  })

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

  it('leaves no row or folder when the hidden login times out or finds no login', async () => {
    const f = fixture()
    f.runLogin.mockRejectedValueOnce(new Error('Claude sign-in took too long to finish.'))
    await expect(f.service.addAccount({ runtime: 'host' })).rejects.toThrow('took too long')
    await expect(f.service.addAccount({ runtime: 'host' })).rejects.toThrow(
      'could not resolve the account email'
    )
    expect(f.settings().claudeManagedAccounts).toHaveLength(2)
    expect(f.runtimeAuth.removeAccountFolder).toHaveBeenCalledTimes(2)
  })

  it('refuses a hidden login to an already added account and deletes its folder', async () => {
    const f = fixture()
    f.runLogin.mockImplementationOnce(async () => {
      f.signIn(newId(f), 'B@example.test')
      return ''
    })
    await expect(f.service.addAccount({ runtime: 'host' })).rejects.toThrow(
      'This Claude account is already added.'
    )
    expect(f.settings().claudeManagedAccounts).toHaveLength(2)
    expect(existsSync(join(f.root, newId(f)))).toBe(false)
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

  it('clears the selection, republishes, then deletes the folder on remove', async () => {
    const f = fixture()
    f.signIn('a', 'a@example.test')
    await f.service.removeAccount('a')
    expect(f.settings().claudeManagedAccounts.map((entry) => entry.id)).toEqual(['b'])
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBeNull()
    expect(f.runtimeAuth.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
    expect(f.runtimeAuth.removeAccountFolder).toHaveBeenCalledWith('a', { runtime: 'host' })
  })

  it("deletes a cancelled sign-in's folder but never a saved account's", async () => {
    const f = fixture()
    const begun = await f.service.beginSignIn({ runtime: 'host' })
    await f.service.cancelSignIn({ accountId: begun.accountId, runtime: 'host' })
    expect(f.runtimeAuth.removeAccountFolder).toHaveBeenCalledWith(begun.accountId, {
      runtime: 'host'
    })
    f.runtimeAuth.removeAccountFolder.mockClear()
    await f.service.cancelSignIn({ accountId: 'a', runtime: 'host' })
    expect(f.runtimeAuth.removeAccountFolder).not.toHaveBeenCalled()
  })

  it('keeps the row when its folder cannot be deleted, so the user can retry', async () => {
    const f = fixture()
    f.runtimeAuth.removeAccountFolder.mockRejectedValueOnce(
      Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    )
    await expect(f.service.removeAccount('a')).rejects.toThrow(CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE)
    expect(f.settings().claudeManagedAccounts.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBeNull()
  })

  it('puts the previous account back when publishing a new selection fails', async () => {
    const f = fixture()
    f.signIn('b', 'b@example.test')
    f.runtimeAuth.syncForCurrentSelection.mockRejectedValueOnce(new Error('publish failed'))
    await expect(f.service.selectAccount('b')).rejects.toThrow('publish failed')
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('a')
    expect(f.runtimeAuth.publishAll).toHaveBeenCalled()
  })

  it('refuses to select an account whose folder holds no login', async () => {
    const f = fixture()
    await expect(f.service.selectAccount('b')).rejects.toThrow(CLAUDE_ACCOUNT_NEEDS_SIGN_IN_MESSAGE)
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('a')
    f.signIn('b', 'b@example.test')
    await f.service.selectAccount('b')
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('b')
  })

  it('refuses to select a WSL account for the host', async () => {
    const f = fixture([
      account('a'),
      account('w', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
    ])
    await expect(f.service.selectAccountForTarget('w', { runtime: 'host' })).rejects.toThrow(
      'That Claude account belongs to a different runtime.'
    )
  })
})
