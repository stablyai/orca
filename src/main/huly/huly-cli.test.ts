import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HulyPreflight } from './huly-cli'
import {
  HulyCliAuthError,
  HulyCliError,
  HulyCliMissingError,
  preflightHulyCli,
  runHulyCli,
  type HulyExecFn
} from './huly-cli'

const connection = {
  id: 'huly-1',
  name: 'Test',
  url: 'https://huly.app',
  workspace: 'main',
  email: null
}

function makeExecMock(stdout: string, stderr = '', code: string | null = null, message = 'fail') {
  // Why: when called with stderr set (and no explicit success stdout), the
  // mock must reject so classifyError runs. Empty stderr = success path.
  const shouldFail = stderr.length > 0 || code !== null
  return vi.fn(async (_file: string, _args: string[], _options: unknown) => {
    if (shouldFail) {
      const err = new Error(message) as Error & { stderr?: string; code?: string }
      err.stderr = stderr
      if (code) {
        err.code = code
      }
      throw err
    }
    return { stdout, stderr }
  }) as unknown as HulyExecFn
}

function lastExecEnv(exec: HulyExecFn): { env: Record<string, string | undefined> } {
  const mock = exec as unknown as { mock: { calls: unknown[][] } }
  return mock.mock.calls[0][2] as { env: Record<string, string | undefined> }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runHulyCli', () => {
  it('passes --json --ci and parses JSON stdout', async () => {
    const exec = makeExecMock('{"id":"i-1"}')
    const result = await runHulyCli<{ id: string }>(
      connection,
      null,
      'token-xyz',
      ['issue', 'get', 'i-1'],
      { exec }
    )
    expect(result).toEqual({ id: 'i-1' })
    expect(exec).toHaveBeenCalledWith(
      'huly',
      ['--json', '--ci', 'issue', 'get', 'i-1'],
      expect.objectContaining({
        env: expect.objectContaining({
          HULY_URL: 'https://huly.app',
          HULY_WORKSPACE: 'main',
          HULY_NONINTERACTIVE: '1',
          HULY_TOKEN: 'token-xyz'
        })
      })
    )
  })

  it('uses HULY_PASSWORD and clears HULY_TOKEN when no token is supplied', async () => {
    const exec = makeExecMock('{}')
    await runHulyCli(connection, 'hunter2', null, ['issue', 'list'], { exec })
    const env = lastExecEnv(exec).env
    expect(env.HULY_PASSWORD).toBe('hunter2')
    expect(env.HULY_TOKEN).toBe('')
    expect(env.HULY_URL).toBe('https://huly.app')
  })

  it('omits both HULY_TOKEN and HULY_PASSWORD when neither is supplied', async () => {
    const exec = makeExecMock('{}')
    await runHulyCli(connection, null, null, ['issue', 'list'], { exec })
    const env = lastExecEnv(exec) as {
      env: Record<string, string | undefined>
    }
    expect(env.env.HULY_PASSWORD).toBe('')
    expect(env.env.HULY_TOKEN).toBe('')
  })

  it('includes HULY_EMAIL when the connection has one', async () => {
    const exec = makeExecMock('{}')
    await runHulyCli({ ...connection, email: 'me@example.com' }, 'pwd', null, ['team', 'list'], {
      exec
    })
    const env = lastExecEnv(exec) as {
      env: Record<string, string | undefined>
    }
    expect(env.env.HULY_EMAIL).toBe('me@example.com')
  })

  it('throws HulyCliMissingError when exec rejects with ENOENT', async () => {
    const exec = makeExecMock('', '', 'ENOENT', 'spawn huly ENOENT')
    await expect(
      runHulyCli(connection, null, 't', ['issue', 'list'], { exec })
    ).rejects.toBeInstanceOf(HulyCliMissingError)
  })

  it('throws HulyCliAuthError when stderr matches an auth-classified pattern', async () => {
    const exec = makeExecMock('', 'Unauthorized: invalid token')
    await expect(
      runHulyCli(connection, null, 't', ['issue', 'list'], { exec })
    ).rejects.toBeInstanceOf(HulyCliAuthError)
  })

  it('throws HulyCliError with stderr context on other failures', async () => {
    const exec = makeExecMock('', 'something else')
    try {
      await runHulyCli(connection, null, 't', ['issue', 'list'], { exec })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(HulyCliError)
      if (e instanceof HulyCliError) {
        expect(e.stderr).toBe('something else')
        expect(e.message).toContain('something else')
      }
    }
  })

  it('throws when stdout is not valid JSON', async () => {
    const exec = makeExecMock('not json')
    await expect(
      runHulyCli(connection, null, 't', ['issue', 'list'], { exec })
    ).rejects.toBeInstanceOf(HulyCliError)
  })

  it('throws when stdout is empty', async () => {
    const exec = makeExecMock('')
    await expect(
      runHulyCli(connection, null, 't', ['issue', 'list'], { exec })
    ).rejects.toBeInstanceOf(HulyCliError)
  })
})

describe('preflightHulyCli', () => {
  it('reports installed + version when huly --version succeeds', async () => {
    const exec = makeExecMock('huly 1.2.3\n')
    const result = await preflightHulyCli({ exec })
    expect(result.installed).toBe(true)
    expect(result.version).toBe('huly 1.2.3')
    expect(result.authenticated).toBe(false)
  })

  it('reports not installed when the binary is missing', async () => {
    const exec = makeExecMock('', '', 'ENOENT', 'spawn huly ENOENT')
    const result: HulyPreflight = await preflightHulyCli({ exec })
    expect(result.installed).toBe(false)
    expect(result.authenticated).toBe(false)
  })

  it('reports not installed with the error message on other failures', async () => {
    const exec = makeExecMock('', '', null, 'permission denied')
    // Force a failure path even though stderr is empty — message === 'permission denied'.
    const fn = vi.fn(async () => {
      throw new Error('permission denied')
    }) as unknown as HulyExecFn
    const result = await preflightHulyCli({ exec: fn })
    expect(result.installed).toBe(false)
    expect(result.error).toBe('permission denied')
    void exec
  })
})
