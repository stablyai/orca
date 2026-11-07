import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type * as SecureFile from '../../shared/secure-file'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE } from './claude-account-registration'
import { CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE } from './claude-account-selection'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import { readClaudeApiEndpointEnv, readClaudeApiEndpointToken } from './claude-api-endpoint'
import { describeClaudeProfile } from './claude-profile-paths'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import { ClaudeAccountService } from './service'

const secureFile = vi.hoisted(() => ({ canProtect: true }))
vi.mock('../../shared/secure-file', async (original) => {
  const actual = await original<typeof SecureFile>()
  return {
    ...actual,
    writeSecureFile: (...args: Parameters<typeof actual.writeSecureFile>) =>
      actual.writeSecureFile(...args) && secureFile.canProtect
  }
})

const roots: string[] = []
afterEach(() => {
  secureFile.canProtect = true
})
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
      // Stand in for profile setup, which puts an endpoint into the folder's settings.
      const env = readClaudeApiEndpointEnv(home(id))
      if (env) {
        writeFileSync(join(home(id), 'settings.json'), JSON.stringify({ env }))
      }
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
  it('adds an endpoint account that needs no sign-in and keeps its token on edit', async () => {
    const f = fixture([account('a')])
    const endpoint = {
      label: 'Sakana AI',
      baseUrl: 'https://api.sakana.ai',
      authToken: 'test-token',
      model: 'fugu',
      smallFastModel: 'fugu'
    }
    const added = await f.service.saveApiEndpointAccount(endpoint)
    const id = newId(f)
    // Once to make the folder, again so its settings carry the endpoint.
    expect(f.runtimeAuth.prepareAccountFolder).toHaveBeenCalledTimes(2)
    const row = added.accounts.find((entry) => entry.id === id)
    expect(row).toMatchObject({
      email: 'Sakana AI',
      authMethod: 'api-endpoint',
      apiEndpoint: { baseUrl: 'https://api.sakana.ai', model: 'fugu', smallFastModel: 'fugu' }
    })
    expect(row?.needsSignIn).toBeUndefined()
    expect(JSON.stringify(f.settings().claudeManagedAccounts)).not.toContain('test-token')
    await expect(f.service.saveApiEndpointAccount(endpoint)).rejects.toThrow('already added')

    const edited = await f.service.saveApiEndpointAccount(
      { ...endpoint, authToken: '', model: 'fugu-ultra' },
      id
    )
    expect(edited.accounts.find((entry) => entry.id === id)?.apiEndpoint?.model).toBe('fugu-ultra')
    expect(readClaudeApiEndpointToken(f.home(id))).toBe('test-token')
    await expect(f.service.selectAccount(id)).resolves.toMatchObject({ activeAccountId: id })
    await expect(f.service.saveApiEndpointAccount(endpoint, 'a')).rejects.toThrow('subscription')
    // The saved token stays with its host, and a Claude login cannot take over the folder.
    await expect(
      f.service.saveApiEndpointAccount(
        { ...endpoint, authToken: '', baseUrl: 'https://elsewhere.example.test' },
        id
      )
    ).rejects.toThrow('token')
    await expect(f.service.reauthenticateAccount(id)).rejects.toThrow('API endpoint token')
    expect(f.runLogin).not.toHaveBeenCalled()
  })

  it('does not save an endpoint account whose settings did not take the endpoint', async () => {
    const f = fixture([account('a')])
    f.runtimeAuth.prepareAccountFolder.mockImplementation(async (id: string) => {
      mkdirSync(f.home(id), { recursive: true })
      return { configDir: f.home(id), readPath: f.home(id) }
    })
    await expect(
      f.service.saveApiEndpointAccount({
        label: 'Sakana AI',
        baseUrl: 'https://api.sakana.ai',
        authToken: 'test-token',
        model: 'fugu',
        smallFastModel: 'fugu'
      })
    ).rejects.toThrow('settings.json')
    expect(f.settings().claudeManagedAccounts.map((entry) => entry.id)).toEqual(['a'])
  })

  it('keeps the old endpoint in the folder when an edit fails', async () => {
    const f = fixture([account('a')])
    const endpoint = {
      label: 'Sakana AI',
      baseUrl: 'https://api.sakana.ai',
      authToken: 'old-token',
      model: 'fugu',
      smallFastModel: 'fugu'
    }
    await f.service.saveApiEndpointAccount(endpoint)
    const id = newId(f)
    const setup = f.runtimeAuth.prepareAccountFolder.getMockImplementation()!
    f.runtimeAuth.prepareAccountFolder
      .mockImplementationOnce(setup)
      .mockImplementationOnce(async (accountId: string) => {
        // Setup fails after settings.json already took the new endpoint.
        await setup(accountId)
        throw new Error('setup failed')
      })

    await expect(
      f.service.saveApiEndpointAccount(
        { ...endpoint, baseUrl: 'https://elsewhere.example.test', authToken: 'new-token' },
        id
      )
    ).rejects.toThrow('setup failed')

    expect(readClaudeApiEndpointToken(f.home(id))).toBe('old-token')
    const { env } = JSON.parse(readFileSync(join(f.home(id), 'settings.json'), 'utf8'))
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.sakana.ai')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('old-token')
    expect(
      f.settings().claudeManagedAccounts.find((entry) => entry.id === id)?.apiEndpoint?.baseUrl
    ).toBe('https://api.sakana.ai')
  })

  it('removes the new endpoint file when the folder had none before a failed edit', async () => {
    const f = fixture([account('a')])
    const endpoint = {
      label: 'Sakana AI',
      baseUrl: 'https://api.sakana.ai',
      authToken: 'old-token',
      model: 'fugu',
      smallFastModel: 'fugu'
    }
    await f.service.saveApiEndpointAccount(endpoint)
    const id = newId(f)
    rmSync(join(f.home(id), 'orca-api-endpoint.json'))
    const setup = f.runtimeAuth.prepareAccountFolder.getMockImplementation()!
    f.runtimeAuth.prepareAccountFolder
      .mockImplementationOnce(setup)
      .mockImplementationOnce(async (accountId: string) => {
        await setup(accountId)
        throw new Error('setup failed')
      })

    await expect(
      f.service.saveApiEndpointAccount({ ...endpoint, authToken: 'new-token' }, id)
    ).rejects.toThrow('setup failed')

    expect(existsSync(join(f.home(id), 'orca-api-endpoint.json'))).toBe(false)
  })

  it('refuses an edit when settings.json keeps the URL but not the new token', async () => {
    const f = fixture([account('a')])
    const endpoint = {
      label: 'Sakana AI',
      baseUrl: 'https://api.sakana.ai',
      authToken: 'old-token',
      model: 'fugu',
      smallFastModel: 'fugu'
    }
    await f.service.saveApiEndpointAccount(endpoint)
    const id = newId(f)
    const setup = f.runtimeAuth.prepareAccountFolder.getMockImplementation()!
    f.runtimeAuth.prepareAccountFolder
      .mockImplementationOnce(setup)
      // Setup leaves a settings.json the user owns as it was.
      .mockImplementationOnce(async () => ({ configDir: f.home(id), readPath: f.home(id) }))

    await expect(
      f.service.saveApiEndpointAccount({ ...endpoint, authToken: 'new-token' }, id)
    ).rejects.toThrow('settings')

    expect(readClaudeApiEndpointToken(f.home(id))).toBe('old-token')
  })

  it('refuses a new endpoint account when its token file cannot be protected', async () => {
    const f = fixture([account('a')])
    secureFile.canProtect = false

    await expect(
      f.service.saveApiEndpointAccount({
        label: 'Sakana AI',
        baseUrl: 'https://api.sakana.ai',
        authToken: 'token',
        model: 'fugu',
        smallFastModel: 'fugu'
      })
    ).rejects.toThrow('Could not restrict')

    expect(f.settings().claudeManagedAccounts.map((entry) => entry.id)).toEqual(['a'])
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

  it.each([
    { email: 'new@example.test', organizationUuid: 'new-org', duplicate: false },
    { email: 'imported@example.test', organizationUuid: 'saved-org', duplicate: true },
    { email: 'current@example.test', organizationUuid: 'current-org', duplicate: true }
  ])(
    'finishes sign-in for $email despite an invalid imported account ID',
    async ({ email, organizationUuid, duplicate }) => {
      const imported = account('invalid.id', {
        email: 'imported@example.test',
        organizationUuid: 'saved-org',
        organizationName: 'Saved organization'
      })
      const f = fixture([imported, account('a')])
      vi.spyOn(f.runtimeAuth.router, 'accountHome').mockImplementation((id) => {
        describeClaudeProfile(f.root, id, { executionHostId: 'local', runtime: 'host' })
        return f.home(id)
      })
      f.signIn('a', 'current@example.test', 'current-org')
      const rows = f.service.listAccounts().accounts
      expect(rows).toEqual([
        expect.objectContaining({
          id: imported.id,
          email: imported.email,
          organizationUuid: imported.organizationUuid,
          organizationName: imported.organizationName,
          needsSignIn: true
        }),
        expect.objectContaining({
          id: 'a',
          email: 'current@example.test',
          organizationUuid: 'current-org'
        })
      ])

      const begun = await f.service.beginSignIn({ runtime: 'host' })
      f.signIn(begun.accountId, email, organizationUuid)
      if (duplicate) {
        await expect(f.service.finishSignIn(begun)).rejects.toThrow('already added')
        expect(existsSync(f.home(begun.accountId))).toBe(false)
        expect(f.settings().claudeManagedAccounts).toEqual([imported, account('a')])
      } else {
        await expect(f.service.finishSignIn(begun)).resolves.toMatchObject({
          accounts: expect.arrayContaining([
            expect.objectContaining({ id: begun.accountId, email, organizationUuid })
          ])
        })
        expect(f.settings().claudeManagedAccounts).toHaveLength(3)
        expect(existsSync(f.home(begun.accountId))).toBe(true)
      }
    }
  )

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

  it('keeps the row when its folder cannot be deleted, so the user can retry', async () => {
    const f = fixture()
    f.runtimeAuth.removeAccountFolder.mockRejectedValueOnce(
      Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    )
    await expect(f.service.removeAccount('a')).rejects.toThrow(CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE)
    expect(f.settings().claudeManagedAccounts.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBeNull()
  })
})
