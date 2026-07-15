import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ACCOUNT_HANDLERS } from './account'
import type { RuntimeClient } from '../runtime-client'

const state = {
  accounts: [
    {
      id: 'personal',
      email: 'me@example.com',
      authMethod: 'subscription-oauth' as const,
      managedAuthRuntime: 'host' as const,
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    },
    {
      id: 'work',
      email: 'work@example.com',
      authMethod: 'subscription-oauth' as const,
      managedAuthRuntime: 'host' as const,
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
  ],
  activeAccountId: 'personal',
  activeAccountIdsByRuntime: { host: 'personal', wsl: { Ubuntu: 'work' } }
}

describe('account CLI handlers', () => {
  const call = vi.fn()
  const client = { call } as unknown as RuntimeClient

  beforeEach(() => {
    call.mockReset()
    vi.spyOn(console, 'log')
      .mockImplementation(() => {})
      .mockClear()
  })

  it('lists accounts and omits credential paths from formatted output', async () => {
    call.mockResolvedValue({ id: 'list', ok: true, result: { claude: state } })
    await ACCOUNT_HANDLERS['account list']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: false
    })
    expect(call).toHaveBeenCalledWith('accounts.list')
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain('* personal')
    expect(vi.mocked(console.log).mock.calls[0][0]).not.toContain('managedAuthPath')
  })

  it('marks the selected WSL account using its runtime snapshot entry', async () => {
    const wslState = {
      ...state,
      accounts: [
        state.accounts[0],
        {
          id: 'work',
          email: 'work@example.com',
          authMethod: 'subscription-oauth' as const,
          managedAuthRuntime: 'wsl' as const,
          wslDistro: 'Ubuntu',
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ]
    }
    call.mockResolvedValue({ id: 'list', ok: true, result: { claude: wslState } })
    await ACCOUNT_HANDLERS['account list']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: false
    })
    const output = vi.mocked(console.log).mock.calls[0][0] as string
    expect(output).toContain('* work work@example.com')
    expect(output).toContain('* personal me@example.com')
  })

  it('falls back to the legacy host selection when runtime metadata is absent', async () => {
    const legacyState = {
      accounts: [
        {
          id: 'personal',
          email: 'me@example.com',
          authMethod: 'subscription-oauth' as const,
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ],
      activeAccountId: 'personal'
    }
    call.mockResolvedValue({ id: 'list', ok: true, result: { claude: legacyState } })
    await ACCOUNT_HANDLERS['account list']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: false
    })
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain(
      '* personal me@example.com subscription-oauth host'
    )
  })

  it('uses the __default__ WSL selection key when the distro name is blank', async () => {
    const defaultWslState = {
      ...state,
      accounts: [
        state.accounts[0],
        {
          id: 'work',
          email: 'work@example.com',
          authMethod: 'subscription-oauth' as const,
          managedAuthRuntime: 'wsl' as const,
          wslDistro: '  ',
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ],
      activeAccountIdsByRuntime: { host: 'personal', wsl: { __default__: 'work' } }
    }
    call.mockResolvedValue({ id: 'list', ok: true, result: { claude: defaultWslState } })
    await ACCOUNT_HANDLERS['account list']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: false
    })
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain(
      '* work work@example.com subscription-oauth wsl'
    )
  })

  it('renders an explicit empty state', async () => {
    call.mockResolvedValue({ id: 'list', ok: true, result: { claude: { ...state, accounts: [] } } })
    await ACCOUNT_HANDLERS['account list']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: false
    })
    expect(vi.mocked(console.log).mock.calls[0][0]).toBe('No Claude accounts found.')
  })

  it('clears selection with JSON null', async () => {
    call
      .mockResolvedValueOnce({ id: 'list', ok: true, result: { claude: state } })
      .mockResolvedValueOnce({
        id: 'select',
        ok: true,
        result: { ...state, activeAccountId: null }
      })
    await ACCOUNT_HANDLERS['account use']({
      flags: new Map([['account', 'null']]),
      client,
      cwd: '/tmp',
      json: false
    })
    expect(call).toHaveBeenNthCalledWith(2, 'accounts.selectClaude', { accountId: null })
  })

  it.each([true, ''])('rejects a valueless selector before runtime RPC (%s)', async (account) => {
    await expect(
      ACCOUNT_HANDLERS['account use']({
        flags: new Map([['account', account]]),
        client,
        cwd: '/tmp',
        json: false
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })
})
