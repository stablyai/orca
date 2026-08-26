import { describe, expect, it, vi } from 'vitest'
import type { CursorAuthDeps } from './cursor-auth'
import { extractIdeAccessToken, readCursorAuthSession } from './cursor-auth'

function processResult(
  overrides: Partial<{ code: number | null; stdout: string; stderr: string }> = {}
): {
  code: number | null
  signal: null
  stdout: string
  stderr: string
  timedOut: boolean
} {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

function makeDeps(overrides: Partial<CursorAuthDeps> = {}): CursorAuthDeps {
  return {
    runProcess: vi.fn().mockResolvedValue(processResult()),
    resolveCliProgram: vi.fn().mockResolvedValue(null),
    ideDbPath: '/fake/state.vscdb',
    readIdeAccessToken: vi.fn().mockReturnValue(null),
    ...overrides
  }
}

describe('readCursorAuthSession', () => {
  it('returns ok/cli when the CLI reports an access token', async () => {
    const runProcess = vi
      .fn()
      .mockResolvedValue(
        processResult({ stdout: JSON.stringify({ auth: { accessToken: 'cli-token-123' } }) })
      )
    const readIdeAccessToken = vi.fn().mockReturnValue(null)
    const deps = makeDeps({
      resolveCliProgram: vi.fn().mockResolvedValue('/usr/local/bin/cursor-agent'),
      runProcess,
      readIdeAccessToken
    })

    const result = await readCursorAuthSession(deps)

    expect(result).toEqual({ status: 'ok', accessToken: 'cli-token-123', source: 'cli' })
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/local/bin/cursor-agent',
        args: ['status', '--format', 'json']
      })
    )
    // Why: a successful CLI read must not fall through to the IDE database.
    expect(readIdeAccessToken).not.toHaveBeenCalled()
  })

  it('falls back to the IDE database when the CLI is not installed', async () => {
    const runProcess = vi.fn()
    const deps = makeDeps({
      resolveCliProgram: vi.fn().mockResolvedValue(null),
      runProcess,
      readIdeAccessToken: vi.fn().mockReturnValue('ide-token-456')
    })

    const result = await readCursorAuthSession(deps)

    expect(result).toEqual({ status: 'ok', accessToken: 'ide-token-456', source: 'ide' })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('returns missing when neither the CLI nor the IDE database has a token', async () => {
    const deps = makeDeps({
      resolveCliProgram: vi.fn().mockResolvedValue(null),
      readIdeAccessToken: vi.fn().mockReturnValue(null)
    })

    const result = await readCursorAuthSession(deps)

    expect(result).toEqual({ status: 'missing' })
  })

  it('returns missing when the CLI exits non-zero without a token and there is no IDE db entry', async () => {
    const deps = makeDeps({
      resolveCliProgram: vi.fn().mockResolvedValue('/usr/local/bin/cursor-agent'),
      runProcess: vi
        .fn()
        .mockResolvedValue(processResult({ code: 1, stdout: '', stderr: 'not signed in' })),
      readIdeAccessToken: vi.fn().mockReturnValue(null)
    })

    const result = await readCursorAuthSession(deps)

    expect(result).toEqual({ status: 'missing' })
  })

  it('returns missing when the CLI status JSON has no accessToken field', async () => {
    const deps = makeDeps({
      resolveCliProgram: vi.fn().mockResolvedValue('/usr/local/bin/cursor-agent'),
      runProcess: vi
        .fn()
        .mockResolvedValue(
          processResult({ stdout: JSON.stringify({ auth: { accessToken: '' } }) })
        ),
      readIdeAccessToken: vi.fn().mockReturnValue(null)
    })

    const result = await readCursorAuthSession(deps)

    expect(result).toEqual({ status: 'missing' })
  })

  it('sanitizes spawn failures and never leaks the token string', async () => {
    const deps = makeDeps({
      resolveCliProgram: vi.fn().mockResolvedValue('/usr/local/bin/cursor-agent'),
      runProcess: vi.fn().mockRejectedValue(new Error('spawn failed leaking secret-token-abc'))
    })

    const result = await readCursorAuthSession(deps)

    expect(result.status).toBe('error')
    expect(JSON.stringify(result)).not.toContain('secret-token-abc')
  })

  it('sanitizes IDE database read failures and never leaks the token string', async () => {
    const deps = makeDeps({
      resolveCliProgram: vi.fn().mockResolvedValue(null),
      readIdeAccessToken: vi.fn().mockImplementation(() => {
        throw new Error('sqlite read failed leaking secret-token-xyz')
      })
    })

    const result = await readCursorAuthSession(deps)

    // Why: a db read failure degrades to "missing" (like a missing file would),
    // so there is no error string at all for a token to leak through.
    expect(result).toEqual({ status: 'missing' })
    expect(JSON.stringify(result)).not.toContain('secret-token-xyz')
  })

  it('does not query the IDE database when the CLI already produced a token', async () => {
    const readIdeAccessToken = vi.fn()
    const deps = makeDeps({
      resolveCliProgram: vi.fn().mockResolvedValue('/usr/local/bin/cursor-agent'),
      runProcess: vi
        .fn()
        .mockResolvedValue(
          processResult({ stdout: JSON.stringify({ auth: { accessToken: 'cli-token' } }) })
        ),
      readIdeAccessToken
    })

    await readCursorAuthSession(deps)

    expect(readIdeAccessToken).not.toHaveBeenCalled()
  })
})

describe('extractIdeAccessToken', () => {
  it('returns the parsed string when the stored value is JSON-encoded', () => {
    expect(extractIdeAccessToken({ value: JSON.stringify('a-real-token') })).toBe('a-real-token')
  })

  it('returns the raw value when it is not valid JSON (a bare JWT-style string)', () => {
    expect(extractIdeAccessToken({ value: 'raw.jwt.token' })).toBe('raw.jwt.token')
  })

  it('returns null when the JSON parses to an object rather than a string', () => {
    expect(extractIdeAccessToken({ value: JSON.stringify({ token: 'nested' }) })).toBeNull()
  })

  it('returns null when the JSON parses to a number rather than a string', () => {
    expect(extractIdeAccessToken({ value: JSON.stringify(12345) })).toBeNull()
  })

  it('returns null for an undefined row', () => {
    expect(extractIdeAccessToken(undefined)).toBeNull()
  })
})
