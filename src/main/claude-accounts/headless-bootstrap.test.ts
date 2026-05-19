import { describe, expect, it, vi, beforeEach } from 'vitest'

const serviceAddMock = vi.fn()
const serviceListMock = vi.fn()
const serviceSelectMock = vi.fn()
const serviceRemoveMock = vi.fn()

vi.mock('./service', () => ({
  loadClaudeAccountServiceHeadless: vi.fn(async () => ({
    addAccount: serviceAddMock,
    list: serviceListMock,
    selectAccount: serviceSelectMock,
    removeAccount: serviceRemoveMock
  }))
}))

import {
  runHeadlessClaudeAccountsAdd,
  runHeadlessClaudeAccountsList,
  runHeadlessClaudeAccountsRemove,
  runHeadlessClaudeAccountsSelect
} from './headless-bootstrap'

beforeEach(() => {
  serviceAddMock.mockReset()
  serviceListMock.mockReset()
  serviceSelectMock.mockReset()
  serviceRemoveMock.mockReset()
  delete process.env.ORCA_SECRETS_PASSPHRASE
})

describe('runHeadlessClaudeAccountsAdd', () => {
  it('invokes service.addAccount with the input payload', async () => {
    serviceAddMock.mockResolvedValueOnce({
      accountId: 'a',
      email: 'Work',
      accounts: [],
      activeAccountId: 'a'
    })
    const result = await runHeadlessClaudeAccountsAdd({
      authMethod: 'anthropic-api-key',
      label: 'Work',
      secretFromUser: 'sk'
    })
    expect(result).toEqual({ accountId: 'a', email: 'Work', accounts: [], activeAccountId: 'a' })
    expect(serviceAddMock).toHaveBeenCalledWith({
      authMethod: 'anthropic-api-key',
      label: 'Work',
      secretFromUser: 'sk'
    })
  })

  it('refuses non-keychain backends without confirmed passphrase', async () => {
    // Why: headless cannot show an Electron modal. We require either a keychain
    // backend or an existing in-process passphrase (e.g. from ORCA_SECRETS_PASSPHRASE).
    delete process.env.ORCA_SECRETS_PASSPHRASE
    serviceAddMock.mockRejectedValueOnce(new Error('Passphrase required'))
    await expect(
      runHeadlessClaudeAccountsAdd({
        authMethod: 'anthropic-api-key',
        label: 'X',
        secretFromUser: 'k'
      })
    ).rejects.toThrow(/passphrase/i)
  })
})

describe('runHeadlessClaudeAccountsList', () => {
  it('returns service.list() result', async () => {
    serviceListMock.mockResolvedValueOnce({ accounts: [{ id: 'a' }] })
    const result = await runHeadlessClaudeAccountsList()
    expect(result).toEqual({ accounts: [{ id: 'a' }] })
  })
})

describe('runHeadlessClaudeAccountsSelect', () => {
  it('forwards account id to service.selectAccount', async () => {
    serviceSelectMock.mockResolvedValueOnce({ activeAccountId: 'a' })
    const result = await runHeadlessClaudeAccountsSelect('a')
    expect(serviceSelectMock).toHaveBeenCalledWith('a')
    expect(result).toEqual({ activeAccountId: 'a' })
  })
})

describe('runHeadlessClaudeAccountsRemove', () => {
  it('forwards account id to service.removeAccount and returns removed:true', async () => {
    serviceRemoveMock.mockResolvedValueOnce({ removed: true })
    const result = await runHeadlessClaudeAccountsRemove('a')
    expect(serviceRemoveMock).toHaveBeenCalledWith('a')
    expect(result).toEqual({ removed: true })
  })
})
