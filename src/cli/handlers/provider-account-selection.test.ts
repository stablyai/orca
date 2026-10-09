import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClient } from '../runtime-client'
import { ACCOUNT_HANDLERS } from './account'
import { formatAccountsBlock } from './account-list-format'
import { DATA_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

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

describe('account select for Claude and Codex', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalBridgeDistro = process.env.ORCA_CLI_WSL_DISTRO
  const client = new RuntimeClient(join(tmpdir(), 'orca-account-select-test'), 1000, null, null)
  let callMock: MockInstance<RuntimeClient['call']>

  function context(agent: string, account?: string): HandlerContext {
    const flags = new Map<string, string | boolean>([['agent', agent]])
    if (account !== undefined) {
      flags.set('account', account)
    }
    return { client, cwd: process.cwd(), flags, json: false, rawArgs: [] }
  }

  beforeEach(() => {
    delete process.env.ORCA_CLI_WSL_DISTRO
    callMock = vi.spyOn(client, 'call').mockImplementation((method: string) =>
      Promise.resolve({
        id: 'test',
        ok: true,
        result:
          method === 'accounts.list'
            ? { claude: claudeAccounts, codex: codexAccounts }
            : method.includes('Claude')
              ? claudeAccounts
              : codexAccounts,
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

  it('selects a Claude account by email, ignoring case', async () => {
    await ACCOUNT_HANDLERS['account select'](context('claude', 'ME@work.example'))

    expect(callMock).toHaveBeenCalledWith('accounts.list', { refreshUsage: false })
    expect(callMock).toHaveBeenCalledWith('accounts.selectClaude', { accountId: 'claude-work' })
  })

  it('selects a Claude account by id', async () => {
    await ACCOUNT_HANDLERS['account select'](context('claude', 'claude-org-b'))

    expect(callMock).toHaveBeenCalledWith('accounts.selectClaude', { accountId: 'claude-org-b' })
  })

  it('maps system to the system default', async () => {
    await ACCOUNT_HANDLERS['account select'](context('codex', 'system'))

    expect(callMock).toHaveBeenCalledWith('accounts.selectCodex', { accountId: null })
  })

  it('refuses an email shared by several accounts and names their ids', async () => {
    await expect(
      ACCOUNT_HANDLERS['account select'](context('claude', 'shared@example.com'))
    ).rejects.toThrow('claude-org-a, claude-org-b')
    expect(callMock).not.toHaveBeenCalledWith('accounts.selectClaude', expect.anything())
  })

  it('refuses an unknown account without switching', async () => {
    await expect(
      ACCOUNT_HANDLERS['account select'](context('claude', 'nobody@example.com'))
    ).rejects.toThrow('No managed Claude account matches')
    expect(callMock).toHaveBeenCalledOnce()
  })

  it('requires --account', async () => {
    await expect(ACCOUNT_HANDLERS['account select'](context('claude'))).rejects.toThrow(
      'Use --account'
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it('targets the bridge distro when selecting Codex from WSL', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'

    await ACCOUNT_HANDLERS['account select'](context('codex', 'codex-1'))

    expect(callMock).toHaveBeenCalledWith('accounts.selectCodexForTarget', {
      accountId: 'codex-1',
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
  })

  it('refuses the Claude system default from WSL rather than resetting the Windows host', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'

    await expect(ACCOUNT_HANDLERS['account select'](context('claude', 'system'))).rejects.toThrow(
      'not supported from the CLI'
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it('keeps OpenCode and Devin on the profile selection path', async () => {
    callMock.mockImplementation((method: string) =>
      Promise.resolve({
        id: 'test',
        ok: true,
        result:
          method === 'status.get'
            ? { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] }
            : { accounts: [], activeAccountId: null },
        _meta: { runtimeId: 'test-runtime' }
      })
    )

    await ACCOUNT_HANDLERS['account select'](context('devin', 'system'))

    expect(callMock).toHaveBeenCalledWith('accounts.selectData', {
      provider: 'devin',
      accountId: null
    })
    expect(callMock).not.toHaveBeenCalledWith('accounts.list', expect.anything())
  })
})

describe('formatAccountsBlock', () => {
  it('prints ids for select and marks the system default when nothing is selected', () => {
    expect(formatAccountsBlock('Codex', codexAccounts)).toBe(
      'Managed Codex accounts (1):\n  system  System default (active)\n  codex-1  me@codex.example'
    )
  })

  it('marks the selected account, not the system default', () => {
    const output = formatAccountsBlock('Claude', claudeAccounts)
    expect(output).toContain('  system  System default\n')
    expect(output).toContain('  claude-work  me@work.example (active)')
  })
})
