import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, REPEATED_FLAG_SEPARATOR, specPaths } from '../args'
import { ACCOUNT_COMMAND_SPECS } from '../specs/account'
import { RuntimeClient } from '../runtime-client'
import { DATA_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/account-runtime-capabilities'
import { addDataAccount } from './data-account-commands'

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

  it('passes OpenCode login method and answers before the standalone flag', async () => {
    vi.spyOn(client, 'call')
      .mockResolvedValueOnce({
        id: 'test',
        ok: true,
        result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] },
        _meta: { runtimeId: 'test' }
      })
      .mockRejectedValueOnce(new Error('capture failed'))
    const login = vi.fn(async (_command: string, args: string[]) => {
      expect(args).toEqual([
        'auth',
        'login',
        'github-copilot',
        '--method',
        ' device ',
        '--answer',
        'deploymentType=github.com',
        '--answer',
        'note name=a=b',
        '--standalone'
      ])
    })
    const flags = new Map<string, string | boolean>([
      ['integration', 'github-copilot'],
      ['method', ' device '],
      ['answer', ['deploymentType=github.com', 'note name=a=b'].join(REPEATED_FLAG_SEPARATOR)]
    ])
    await expect(addDataAccount({ ...context, flags }, 'opencode', login)).rejects.toThrow(
      'capture failed'
    )
    expect(login).toHaveBeenCalledOnce()
  })

  it.each([
    ['devin', new Map([['method', 'device']]), 'only supported with --agent opencode'],
    ['opencode', new Map([['method', ' ']]), '--method requires'],
    ['opencode', new Map([['answer', 'deployment']]), 'key=value'],
    ['opencode', new Map([['answer', '=github.com']]), 'key=value'],
    ['opencode', new Map([['answer', '--server=http://example.test']]), 'key=value'],
    ['opencode', new Map([['method', '--server']]), '--method requires'],
    [
      'opencode',
      new Map([['integration', '--server=http://example.test']]),
      '--integration requires'
    ],
    ['opencode', new Map([['integration', ' -x']]), '--integration requires'],
    [
      'opencode',
      parseArgs(
        ['account', 'add', '--answer=', '--answer', 'deploymentType=github.com'],
        ACCOUNT_COMMAND_SPECS.flatMap(specPaths),
        ACCOUNT_COMMAND_SPECS
      ).flags,
      'key=value'
    ]
  ] as const)(
    'refuses invalid %s login options before any runtime call',
    async (provider, flags, message) => {
      const call = vi.spyOn(client, 'call')
      const login = vi.fn()
      await expect(addDataAccount({ ...context, flags }, provider, login)).rejects.toThrow(message)
      expect(call).not.toHaveBeenCalled()
      expect(login).not.toHaveBeenCalled()
    }
  )
})
