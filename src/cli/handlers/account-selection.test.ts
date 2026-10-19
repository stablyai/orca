import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { ACCOUNT_HANDLERS } from './account'
import { formatAccountsBlock, formatAntigravityAccounts } from './account-list-format'
import { resolveAccountId } from './account-selection'
import {
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  DATA_ACCOUNT_RUNTIME_CAPABILITY
} from '../../shared/account-runtime-capabilities'

const claudeAccounts = {
  accounts: [
    { id: 'claude-work', email: 'me@work.example' },
    { id: 'claude-org-a', email: 'shared@example.com' },
    { id: 'claude-org-b', email: 'shared@example.com' }
  ],
  activeAccountId: 'claude-work',
  activeAccountIdsByRuntime: { host: 'claude-work', wsl: {} }
}
const codexAccounts = {
  accounts: [{ id: 'codex-1', email: 'me@codex.example' }],
  activeAccountId: null
}
const dataAccounts = {
  opencode: {
    accounts: [{ id: 'oc-1', label: 'Perso', integrations: [], createdAt: 1 }],
    activeAccountId: null
  },
  devin: {
    accounts: [{ id: 'devin-1', label: 'Work', integrations: [], createdAt: 1 }],
    activeAccountId: 'devin-1'
  }
}
const antigravityAccounts = {
  accounts: [
    {
      id: 'agy-1',
      email: 'me@gmail.example',
      subject: 'sub-1',
      authMethod: 'oauth',
      createdAt: 1,
      updatedAt: 1
    },
    { id: 'agy-2', email: null, subject: 'sub-2', authMethod: 'oauth', createdAt: 1, updatedAt: 1 }
  ],
  activeAccountId: 'agy-1',
  currentAccount: null,
  selectedAccountId: 'agy-1'
}

describe('resolveAccountId', () => {
  const accounts = [
    { id: 'a1', names: ['Me@Example.com'] },
    { id: 'a2', names: ['shared@example.com'] },
    { id: 'a3', names: ['shared@example.com', null] }
  ]

  it('prefers an exact id, then a case-insensitive email or label', () => {
    expect(resolveAccountId('Claude', accounts, 'a2', { allowSystem: true })).toBe('a2')
    expect(resolveAccountId('Claude', accounts, 'me@example.COM', { allowSystem: true })).toBe('a1')
  })

  it('maps system to null only where the provider has a system default', () => {
    expect(resolveAccountId('Claude', accounts, 'system', { allowSystem: true })).toBeNull()
    expect(() =>
      resolveAccountId('Antigravity', accounts, 'system', { allowSystem: false })
    ).toThrow('Antigravity has no system default')
  })

  it('refuses an ambiguous name and lists the matching ids', () => {
    expect(() =>
      resolveAccountId('Claude', accounts, 'shared@example.com', { allowSystem: true })
    ).toThrow('a2, a3')
  })

  it('refuses an unknown account', () => {
    expect(() => resolveAccountId('Claude', accounts, 'nobody', { allowSystem: true })).toThrow(
      'No managed Claude account matches "nobody"'
    )
  })
})

describe('account select and rm for every provider', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalBridgeDistro = process.env.ORCA_CLI_WSL_DISTRO
  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient
  let capabilities: string[]

  function context(
    agent: string | boolean | undefined,
    account?: string | boolean
  ): HandlerContext {
    const flags = new Map<string, string | boolean>()
    if (agent !== undefined) {
      flags.set('agent', agent)
    }
    if (account !== undefined) {
      flags.set('account', account)
    }
    return { client, cwd: process.cwd(), flags, json: false, rawArgs: [] }
  }

  function resultFor(method: string): unknown {
    if (method === 'status.get') {
      return { capabilities }
    }
    if (method === 'accounts.list') {
      return { claude: claudeAccounts, codex: codexAccounts, ...dataAccounts }
    }
    if (method === 'accounts.listData') {
      return dataAccounts
    }
    if (method.startsWith('accounts.antigravity')) {
      return antigravityAccounts
    }
    if (method.endsWith('Data')) {
      return dataAccounts.opencode
    }
    return method.includes('Claude') ? claudeAccounts : codexAccounts
  }

  function mutatingCalls(): string[] {
    return callMock.mock.calls
      .map(([method]) => String(method))
      .filter((method) => /\.(select|remove|antigravitySelect|antigravityRemove)/.test(method))
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    delete process.env.ORCA_CLI_WSL_DISTRO
    capabilities = [DATA_ACCOUNT_RUNTIME_CAPABILITY, ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY]
    callMock.mockReset().mockImplementation((method: string) =>
      Promise.resolve({
        id: 'test',
        ok: true,
        result: resultFor(method),
        _meta: { runtimeId: 'test-runtime' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.restoreAllMocks()
    if (originalBridgeDistro === undefined) {
      delete process.env.ORCA_CLI_WSL_DISTRO
    } else {
      process.env.ORCA_CLI_WSL_DISTRO = originalBridgeDistro
    }
  })

  it.each([
    ['claude', 'ME@work.example', 'accounts.selectClaude', { accountId: 'claude-work' }],
    ['claude', 'claude-org-b', 'accounts.selectClaude', { accountId: 'claude-org-b' }],
    ['codex', 'system', 'accounts.selectCodex', { accountId: null }],
    ['opencode', 'perso', 'accounts.selectData', { provider: 'opencode', accountId: 'oc-1' }],
    ['devin', 'system', 'accounts.selectData', { provider: 'devin', accountId: null }],
    [
      'antigravity',
      'me@gmail.example',
      'accounts.antigravitySelect',
      { target: { runtime: 'host' }, accountId: 'agy-1' }
    ],
    [
      'antigravity',
      'sub-2',
      'accounts.antigravitySelect',
      { target: { runtime: 'host' }, accountId: 'agy-2' }
    ]
  ])('selects %s account %s', async (agent, account, method, params) => {
    await ACCOUNT_HANDLERS['account select'](context(agent, account))

    expect(callMock).toHaveBeenCalledWith(method, params)
    expect(mutatingCalls()).toEqual([method])
  })

  it.each([
    ['claude', 'me@work.example', 'accounts.removeClaude', { accountId: 'claude-work' }],
    ['codex', 'codex-1', 'accounts.removeCodex', { accountId: 'codex-1' }],
    ['opencode', 'oc-1', 'accounts.removeData', { provider: 'opencode', accountId: 'oc-1' }],
    ['devin', 'work', 'accounts.removeData', { provider: 'devin', accountId: 'devin-1' }],
    [
      'antigravity',
      'agy-2',
      'accounts.antigravityRemove',
      { target: { runtime: 'host' }, accountId: 'agy-2' }
    ]
  ])('removes %s account %s', async (agent, account, method, params) => {
    await ACCOUNT_HANDLERS['account rm'](context(agent, account))

    expect(callMock).toHaveBeenCalledWith(method, params)
    expect(mutatingCalls()).toEqual([method])
  })

  it('never removes the system default', async () => {
    await expect(ACCOUNT_HANDLERS['account rm'](context('claude', 'system'))).rejects.toThrow(
      'System credentials are never removed'
    )
    expect(mutatingCalls()).toEqual([])
  })

  it('refuses an email shared by several accounts without switching or removing', async () => {
    await expect(
      ACCOUNT_HANDLERS['account select'](context('claude', 'shared@example.com'))
    ).rejects.toThrow('claude-org-a, claude-org-b')
    await expect(
      ACCOUNT_HANDLERS['account rm'](context('claude', 'shared@example.com'))
    ).rejects.toThrow('claude-org-a, claude-org-b')
    expect(mutatingCalls()).toEqual([])
  })

  it('refuses an unknown account without switching', async () => {
    await expect(
      ACCOUNT_HANDLERS['account select'](context('codex', 'nobody@example.com'))
    ).rejects.toThrow('No managed Codex account matches')
    expect(mutatingCalls()).toEqual([])
  })

  it('refuses the Antigravity system default, which its host cannot select', async () => {
    await expect(
      ACCOUNT_HANDLERS['account select'](context('antigravity', 'system'))
    ).rejects.toThrow('Antigravity has no system default')
    expect(mutatingCalls()).toEqual([])
  })

  it.each([
    [undefined, 'claude-work', 'Use --agent claude|codex|opencode|devin|antigravity'],
    [true, 'claude-work', 'Use --agent claude|codex|opencode|devin|antigravity'],
    ['gemini', 'claude-work', 'Unsupported --agent "gemini"'],
    ['claude', undefined, 'Use --account <id|email|label|system>'],
    ['claude', true, 'Use --account <id|email|label|system>']
  ])(
    'refuses --agent %s --account %s before calling the runtime',
    async (agent, account, error) => {
      await expect(ACCOUNT_HANDLERS['account select'](context(agent, account))).rejects.toThrow(
        error
      )
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it('targets the bridge distro when selecting Codex from WSL', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'

    await ACCOUNT_HANDLERS['account select'](context('codex', 'codex-1'))

    expect(callMock).toHaveBeenCalledWith('accounts.selectCodexForTarget', {
      accountId: 'codex-1',
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
  })

  it('surfaces the host refusal for Antigravity from WSL without selecting', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'
    // Why: the host refuses every client-selected WSL target, reads included
    // (getAntigravityAccountService), so the CLI must stop at the list call.
    const respond = callMock.getMockImplementation()!
    callMock.mockImplementation((method: string, params: unknown) =>
      method.startsWith('accounts.antigravity')
        ? Promise.reject(
            new Error(
              'Antigravity account management for a client-selected WSL distro is not supported yet.'
            )
          )
        : respond(method, params)
    )

    await expect(
      ACCOUNT_HANDLERS['account select'](context('antigravity', 'agy-1'))
    ).rejects.toThrow('client-selected WSL distro is not supported yet')

    expect(callMock).toHaveBeenCalledWith('accounts.antigravityList', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(mutatingCalls()).toEqual([])
  })

  it('refuses the Claude system default from WSL rather than resetting the Windows host', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'

    await expect(ACCOUNT_HANDLERS['account select'](context('claude', 'system'))).rejects.toThrow(
      'Select the Claude system default for a WSL distro in Orca Settings'
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each([
    ['devin', DATA_ACCOUNT_RUNTIME_CAPABILITY],
    ['antigravity', ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY]
  ])('refuses %s on a runtime without its account capability', async (agent, capability) => {
    capabilities = capabilities.filter((entry) => entry !== capability)

    await expect(ACCOUNT_HANDLERS['account select'](context(agent, 'system'))).rejects.toThrow(
      'Update or restart this Orca host'
    )
    expect(mutatingCalls()).toEqual([])
  })

  it('lists one provider with --agent', async () => {
    await ACCOUNT_HANDLERS['account list'](context('antigravity'))

    expect(console.log).toHaveBeenCalledWith(
      'Managed Antigravity accounts (2):\n  agy-1  me@gmail.example (active)\n  agy-2  sub-2'
    )
  })

  it('adds Antigravity to the full list when the host supports it', async () => {
    await ACCOUNT_HANDLERS['account list'](context(undefined))

    expect(callMock).toHaveBeenCalledWith('accounts.antigravityList', { runtime: 'host' })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('\n\nManaged Antigravity accounts (2):')
    )
  })

  it('omits Antigravity from the full list on an older host', async () => {
    capabilities = [DATA_ACCOUNT_RUNTIME_CAPABILITY]

    await ACCOUNT_HANDLERS['account list'](context(undefined))

    expect(callMock).not.toHaveBeenCalledWith('accounts.antigravityList', expect.anything())
    expect(console.log).toHaveBeenCalledWith(expect.not.stringContaining('Antigravity'))
  })

  it('still lists the other providers when this host cannot switch Antigravity accounts', async () => {
    callMock.mockImplementation((method: string) =>
      method === 'accounts.antigravityList'
        ? Promise.reject(new Error('Native Antigravity account switching is not supported'))
        : Promise.resolve({
            id: 'test',
            ok: true,
            result: resultFor(method),
            _meta: { runtimeId: 'test-runtime' }
          })
    )

    await ACCOUNT_HANDLERS['account list'](context(undefined))

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Managed Claude accounts'))
    expect(console.log).toHaveBeenCalledWith(expect.not.stringContaining('Antigravity'))
  })
})

describe('account list formatting', () => {
  it('prints ids and the system default for Claude and Codex', () => {
    expect(formatAccountsBlock('Codex', codexAccounts)).toBe(
      'Managed Codex accounts (1):\n  system  System default (active)\n  codex-1  me@codex.example'
    )
    const claude = formatAccountsBlock('Claude', claudeAccounts)
    expect(claude).toContain('  system  System default\n')
    expect(claude).toContain('  claude-work  me@work.example (active)')
  })

  it('still offers the system default when no account is saved', () => {
    expect(formatAccountsBlock('Codex', { accounts: [], activeAccountId: null })).toBe(
      'No managed Codex accounts.\n  system  System default (active)'
    )
  })

  it('names an Antigravity account by email, then by subject', () => {
    expect(formatAntigravityAccounts(antigravityAccounts)).toBe(
      'Managed Antigravity accounts (2):\n  agy-1  me@gmail.example (active)\n  agy-2  sub-2'
    )
    expect(
      formatAntigravityAccounts({ ...antigravityAccounts, accounts: [], activeAccountId: null })
    ).toBe('No managed Antigravity accounts.')
  })
})
