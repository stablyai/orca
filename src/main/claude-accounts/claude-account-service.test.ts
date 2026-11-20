import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/agent-accounts/managed-account-types'

import type { ClaudeCommandConfig, ClaudeCommandOptions } from './sign-in/claude-command-process'

import type { ClaudeAccountSelectionTarget } from './selection/runtime-selection'
import { ClaudeAccountService } from './service'
import { CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE } from './selection/claude-account-selection'

const spawnProcess = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawnProcess
}))
vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveClaudeCommand: () => 'claude'
}))

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

function fixture(
  accounts: ClaudeManagedAccount[] = [account('a'), account('b')],
  options: { spawnClaude?: boolean; settings?: Partial<GlobalSettings> } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'claude-accounts-'))
  roots.push(root)
  const home = (id: string) => join(root, id, 'home')
  const signIn = (
    id: string,
    email: string,
    organizationUuid?: string,
    organizationName?: string
  ) => {
    mkdirSync(home(id), { recursive: true })
    writeFileSync(
      join(home(id), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid, organizationName } })
    )
  }
  const covered = new Set<string>()
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: {} },
    ...options.settings
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
  // A settings observer, run after each write lands, as the store notifies its listeners.
  let observe: ((patch: Partial<GlobalSettings>) => void) | null = null
  const service = new ClaudeAccountService(
    {
      getSettings: () => settings,
      updateSettings: (patch) => {
        settings = { ...settings, ...patch }
        observe?.(patch)
      }
    },
    {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
    },
    runtimeAuth,
    options.spawnClaude ? undefined : runLogin
  )
  return {
    root,
    home,
    service,
    runtimeAuth,
    runLogin,
    signIn,
    covered,
    settings: () => settings,
    observeSettings: (next: typeof observe) => {
      observe = next
    }
  }
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

  it('refuses to sign a saved account in again as a login another account already has', async () => {
    const f = fixture()
    f.signIn('a', 'a@example.test')
    f.runLogin.mockImplementationOnce(async () => {
      f.signIn('b', 'a@example.test')
      return ''
    })
    await expect(f.service.reauthenticateAccount('b')).rejects.toThrow(
      'You signed in as a@example.test, which another Claude account already uses. Sign in again as b@example.test.'
    )
    expect(f.settings().claudeManagedAccounts.find((entry) => entry.id === 'b')).toMatchObject({
      email: 'b@example.test'
    })
    expect(f.runtimeAuth.removeAccountFolder).not.toHaveBeenCalled()
  })

  it('names the organization when a refused sign-in again shares the saved email', async () => {
    const f = fixture([
      account('a', { email: 'x@example.test', organizationUuid: 'team' }),
      account('b', {
        email: 'x@example.test',
        organizationUuid: 'personal',
        organizationName: 'Personal'
      })
    ])
    f.signIn('a', 'x@example.test', 'team', 'Team')
    f.runLogin.mockImplementationOnce(async () => {
      f.signIn('b', 'x@example.test', 'team', 'Team')
      return ''
    })
    await expect(f.service.reauthenticateAccount('b')).rejects.toThrow(
      'You signed in as x@example.test (Team), which another Claude account already uses. Sign in again as x@example.test (Personal).'
    )
  })

  it('signs a saved account in again as its own login while another folder holds it', async () => {
    const f = fixture()
    f.signIn('a', 'b@example.test')
    f.runLogin.mockImplementationOnce(async () => {
      f.signIn('b', 'B@example.test')
      return ''
    })
    await f.service.reauthenticateAccount('b')
    expect(f.settings().claudeManagedAccounts.find((entry) => entry.id === 'b')).toMatchObject({
      email: 'B@example.test'
    })
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

  it('signs Claude in through the proxy configured in settings', async () => {
    const f = fixture([], {
      spawnClaude: true,
      settings: { httpProxyUrl: 'http://127.0.0.1:7890', httpProxyBypassRules: 'corp.test' }
    })
    // Claude's token exchange after the browser callback only reaches Anthropic through the proxy.
    spawnProcess.mockImplementationOnce(({ env }: { env: NodeJS.ProcessEnv }) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: null,
        kill: vi.fn()
      })
      setImmediate(() => {
        if (env.HTTPS_PROXY === 'http://127.0.0.1:7890' && env.NO_PROXY === 'corp.test') {
          f.signIn(newId(f), 'proxied@example.test')
        }
        child.emit('exit', 0)
        child.emit('close', 0)
      })
      return child
    })
    await expect(f.service.addAccount({ runtime: 'host' })).resolves.toMatchObject({
      accounts: [expect.objectContaining({ email: 'proxied@example.test' })]
    })
  })

  it('tells its listeners once a selection takes effect, and rechecks after one that rolled back', async () => {
    const f = fixture()
    const told: (() => boolean)[] = []
    f.service.onSelectionApplied((committed) => told.push(committed))
    for (const id of ['a', 'b']) {
      f.signIn(id, `${id}@example.test`)
      writeFileSync(
        join(f.home(id), '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh' } })
      )
    }
    await f.service.selectAccount('b')
    expect(told).toHaveLength(1)
    expect(told[0]!()).toBe(true)

    // While a later select is saved but not yet in effect, the earlier one is no longer committed.
    let sawPending: boolean | undefined
    f.runtimeAuth.syncForCurrentSelection.mockImplementationOnce(async () => {
      sawPending = told[0]!()
      throw new Error('publish failed')
    })
    await expect(f.service.selectAccount('a')).rejects.toThrow('publish failed')
    expect(sawPending).toBe(false)
    expect(f.settings().activeClaudeManagedAccountId).toBe('b')
    // The restored selection is told again, so a run skipped while it was pending is redone.
    expect(told).toHaveLength(2)
    expect(told[0]!()).toBe(false)
    expect(told[1]!()).toBe(true)

    await f.service.selectAccountForTarget(null, { runtime: 'host' })
    expect(told).toHaveLength(3)
    expect(told[1]!()).toBe(false)
    // Removing an account nothing selects moves no one.
    await f.service.removeAccount('b')
    expect(told).toHaveLength(3)
  })

  it('keeps a switch check alive across removing an account nothing selects', async () => {
    const f = fixture([account('a'), account('b'), account('c'), account('d')])
    const told: (() => boolean)[] = []
    f.service.onSelectionApplied((committed) => told.push(committed))
    for (const id of ['c', 'd']) {
      mkdirSync(f.home(id), { recursive: true })
    }
    f.signIn('b', 'b@example.test')
    writeFileSync(
      join(f.home('b'), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh' } })
    )
    await f.service.selectAccount('b')
    expect(told).toHaveLength(1)

    // B's delayed check reaches its stop while C's removal is still in progress: it stands down...
    let duringRemoval: boolean | undefined
    f.runtimeAuth.syncForCurrentSelection.mockImplementationOnce(async () => {
      duringRemoval = told[0]!()
    })
    await f.service.removeAccount('c')
    expect(duringRemoval).toBe(false)
    // ...and the removal, which left B selected, tells listeners again so the check is redone.
    expect(told).toHaveLength(2)
    expect(told[1]!()).toBe(true)
    // A check that runs only after the removal still stands for B.
    expect(told[0]!()).toBe(true)

    // A removal no check waited on tells no one.
    await f.service.removeAccount('d')
    expect(told).toHaveLength(2)
    expect(told[1]!()).toBe(true)
  })

  it('restores the selection when removing the selected account cannot publish its deselection', async () => {
    const f = fixture()
    const told: (() => boolean)[] = []
    f.service.onSelectionApplied((committed) => told.push(committed))
    f.runtimeAuth.syncForCurrentSelection.mockRejectedValueOnce(new Error('publish failed'))

    await expect(f.service.removeAccount('a')).rejects.toThrow('publish failed')
    // New launches still use A, so A stays selected and listed; nothing running on A may move.
    expect(f.settings().activeClaudeManagedAccountId).toBe('a')
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('a')
    expect(f.service.listAccounts().accounts.map((entry) => entry.id)).toContain('a')
    expect(f.runtimeAuth.publishAll).toHaveBeenCalled()
    expect(f.runtimeAuth.removeAccountFolder).not.toHaveBeenCalled()
  })

  it('keeps the selected account when a settings observer fails while removing it', async () => {
    const f = fixture()
    const told: (() => boolean)[] = []
    f.service.onSelectionApplied((committed) => told.push(committed))
    f.signIn('a', 'a@example.test')
    // The deselection lands in settings, then an observer throws before anything is published.
    f.observeSettings((patch) => {
      if (patch.activeClaudeManagedAccountId === null) {
        f.observeSettings(null)
        throw new Error('observer failed')
      }
    })

    await expect(f.service.removeAccount('a')).rejects.toThrow('observer failed')
    expect(f.settings().activeClaudeManagedAccountId).toBe('a')
    expect(f.service.listAccounts().accounts.map((entry) => entry.id)).toContain('a')
    expect(existsSync(f.home('a'))).toBe(true)
    expect(f.runtimeAuth.removeAccountFolder).not.toHaveBeenCalled()
    // Its recheck runs against A, which nothing running on A has to leave.
    expect(told).toHaveLength(1)
    expect(told[0]!()).toBe(true)

    // A later switch still takes effect and is told.
    f.signIn('b', 'b@example.test')
    writeFileSync(
      join(f.home('b'), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh' } })
    )
    await f.service.selectAccount('b')
    expect(f.settings().activeClaudeManagedAccountId).toBe('b')
    expect(told).toHaveLength(2)
    expect(told[1]!()).toBe(true)
  })

  it('lets no check act while a failed change could not restore the earlier selection', async () => {
    const f = fixture()
    const told: (() => boolean)[] = []
    f.service.onSelectionApplied((committed) => told.push(committed))
    for (const id of ['a', 'b']) {
      f.signIn(id, `${id}@example.test`)
      writeFileSync(
        join(f.home(id), '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh' } })
      )
    }
    await f.service.selectAccount('b')
    expect(told).toHaveLength(1)

    f.runtimeAuth.syncForCurrentSelection.mockRejectedValueOnce(new Error('publish failed'))
    f.runtimeAuth.publishAll.mockRejectedValueOnce(new Error('republish failed'))
    await expect(f.service.selectAccount('a')).rejects.toThrow('publish failed')
    // Which account new launches use is unknown: the earlier check stands down, and none is told.
    expect(told).toHaveLength(1)
    expect(told[0]!()).toBe(false)

    // The next change that settles tells listeners again.
    await f.service.selectAccount('a')
    expect(told).toHaveLength(2)
    expect(told[1]!()).toBe(true)
  })

  it('tells its listeners when removing the selected account moves off it, though its folder stays', async () => {
    const f = fixture()
    const applied = vi.fn()
    f.service.onSelectionApplied(applied)
    f.runtimeAuth.removeAccountFolder.mockRejectedValueOnce(new Error('busy'))

    await expect(f.service.removeAccount('a')).rejects.toThrow(CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE)
    // New launches already use System default; the account stays listed to retry the delete.
    expect(f.settings().activeClaudeManagedAccountId).toBeNull()
    expect(f.service.listAccounts().accounts.map((entry) => entry.id)).toContain('a')
    expect(applied).toHaveBeenCalledTimes(1)
  })
})
