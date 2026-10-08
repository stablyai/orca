import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeClient } from '../runtime-client'
import { DATA_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { addDataAccount, listDataAccounts } from './data-account-commands'

const client = new RuntimeClient(join(tmpdir(), 'orca-login-test'), 1000, null, null)
const context = {
  client,
  cwd: tmpdir(),
  flags: new Map([['integration', 'opencode-go']]),
  json: true,
  rawArgs: []
}

afterEach(() => vi.restoreAllMocks())

describe('managed data account enrollment', () => {
  it.each(['opencode', 'devin'])(
    'shows the active System default for an empty %s roster',
    async (provider) => {
      vi.spyOn(client, 'call')
        .mockResolvedValueOnce({
          id: 'test',
          ok: true,
          result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] },
          _meta: { runtimeId: 'test' }
        })
        .mockResolvedValueOnce({
          id: 'test',
          ok: true,
          result: { [provider]: { accounts: [], activeAccountId: null } },
          _meta: { runtimeId: 'test' }
        })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      await listDataAccounts({ ...context, json: false }, provider)
      expect(log).toHaveBeenCalledWith(
        `No managed ${provider} accounts.\n  system  System default (active)`
      )
    }
  )

  it('refuses an old host before starting login', async () => {
    vi.spyOn(client, 'call').mockResolvedValue({
      id: 'test',
      ok: true,
      result: { capabilities: [] },
      _meta: { runtimeId: 'test' }
    })
    const login = vi.fn()
    await expect(addDataAccount(context, 'opencode', login)).rejects.toThrow('Update or restart')
    expect(login).not.toHaveBeenCalled()
  })

  it('isolates official login and removes credentials after failed capture', async () => {
    const call = vi.spyOn(client, 'call')
    call
      .mockResolvedValueOnce({
        id: 'test',
        ok: true,
        result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] },
        _meta: { runtimeId: 'test' }
      })
      .mockRejectedValueOnce(new Error('capture failed'))
    let directory = ''
    const login = vi.fn(async (command: string, args: string[], env: Record<string, string>) => {
      expect(command).toBe('opencode')
      expect(args).toEqual(['auth', 'login', 'opencode-go', '--standalone'])
      directory = dirname(env.XDG_DATA_HOME)
      expect(env.XDG_STATE_HOME).toBe(join(directory, 'state'))
      expect(env.OPENCODE_AUTH_CONTENT).toBe('')
      expect(env.OPENCODE_DB).toBe('opencode.db')
      expect(existsSync(directory)).toBe(true)
    })
    await expect(addDataAccount(context, 'opencode', login)).rejects.toThrow('capture failed')
    expect(call).toHaveBeenLastCalledWith('accounts.addDataFromHome', {
      provider: 'opencode',
      sourceDataHome: join(directory, 'data'),
      label: 'opencode'
    })
    expect(existsSync(directory)).toBe(false)
  })
})
