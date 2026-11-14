import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeClient } from '../runtime/client'
import type { RuntimeRpcSuccess } from '../runtime/types'
import { DATA_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/account-runtime-capabilities'
import { addDataAccount } from './data-account-commands'
import { z } from 'zod'

const accountAddParamsSchema = z.object({ sourceDataHome: z.string() })

const client = new RuntimeClient(join(tmpdir(), 'orca-login-test'), 1000, null, null)
const context = {
  client,
  cwd: tmpdir(),
  flags: new Map([['integration', 'opencode-go']]),
  json: true,
  rawArgs: []
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('managed data account enrollment', () => {
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

  it('captures Devin Windows AppData credentials before importing and restores the host login', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-devin-account-add-'))
    const appData = join(root, 'appdata')
    const hostCredential = join(appData, 'devin', 'credentials.toml')
    mkdirSync(dirname(hostCredential), { recursive: true })
    writeFileSync(hostCredential, 'windsurf_api_key = "existing"\n')
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubEnv('APPDATA', appData)
    const call = vi.spyOn(client, 'call')
    call
      .mockResolvedValueOnce({
        id: 'test',
        ok: true,
        result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] },
        _meta: { runtimeId: 'test' }
      })
      .mockImplementationOnce(async (_method, params) => {
        const { sourceDataHome } = accountAddParamsSchema.parse(params)
        expect(readFileSync(join(sourceDataHome, 'devin', 'credentials.toml'), 'utf8')).toBe(
          'windsurf_api_key = "new"\n'
        )
        return {
          id: 'test',
          ok: true,
          result: { accounts: [], activeAccountId: null },
          _meta: { runtimeId: 'test' }
        } satisfies RuntimeRpcSuccess<unknown>
      })
    const login = vi.fn(async (_command: string, args: string[], env: Record<string, string>) => {
      expect(args).toEqual(['auth', 'login', '--force-manual-token-flow'])
      expect(env.APPDATA).toBe(env.XDG_DATA_HOME)
      writeFileSync(hostCredential, 'windsurf_api_key = "new"\n')
    })

    try {
      await addDataAccount(
        { ...context, cwd: root, flags: new Map<string, string | boolean>() },
        'devin',
        login
      )
      expect(readFileSync(hostCredential, 'utf8')).toBe('windsurf_api_key = "existing"\n')
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
      rmSync(root, { recursive: true, force: true })
    }
  })
})
