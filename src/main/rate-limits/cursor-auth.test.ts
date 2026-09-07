import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CursorAuthDeps } from './cursor-auth'
import { getCursorCliAuthPath, readCursorAuthSession } from './cursor-auth'

/** Test double for {@link CursorAuthDeps}; `readFile` rejects with ENOENT unless overridden. */
function makeDeps(overrides: Partial<CursorAuthDeps> = {}): CursorAuthDeps {
  return {
    authFilePath: join('/fake', '.cursor', 'auth.json'),
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    ...overrides
  }
}

describe('readCursorAuthSession', () => {
  it('returns ok/cli when auth.json holds an access token', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ accessToken: 'cli-token-123', refreshToken: 'r' }))
    const deps = makeDeps({ readFile })

    const result = await readCursorAuthSession({ deps })

    expect(result).toEqual({ status: 'ok', accessToken: 'cli-token-123', source: 'cli' })
    expect(readFile).toHaveBeenCalledWith(deps.authFilePath)
  })

  it('returns missing when auth.json does not exist', async () => {
    const result = await readCursorAuthSession({ deps: makeDeps() })

    expect(result).toEqual({ status: 'missing' })
  })

  it('returns missing when auth.json has no access token (signed out)', async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ refreshToken: 'r' }))
    })

    const result = await readCursorAuthSession({ deps })

    expect(result).toEqual({ status: 'missing' })
  })

  it('returns missing when the access token is an empty string', async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ accessToken: '' }))
    })

    const result = await readCursorAuthSession({ deps })

    expect(result).toEqual({ status: 'missing' })
  })

  it('returns a sanitized error when auth.json is not valid JSON', async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue('{not json') })

    const result = await readCursorAuthSession({ deps })

    expect(result).toEqual({ status: 'error', error: 'Cursor auth file is invalid' })
  })

  it('returns a sanitized error when auth.json is JSON but not an object', async () => {
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue('"just-a-string"') })

    const result = await readCursorAuthSession({ deps })

    expect(result).toEqual({ status: 'error', error: 'Cursor auth file is invalid' })
  })

  it('never leaks the auth path or token through filesystem errors', async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockRejectedValue(
        Object.assign(new Error('EACCES: /Users/someone/.cursor/auth.json secret-token-abc'), {
          code: 'EACCES'
        })
      )
    })

    const result = await readCursorAuthSession({ deps })

    expect(result).toEqual({ status: 'error', error: 'Unable to read Cursor auth file' })
    expect(JSON.stringify(result)).not.toContain('secret-token-abc')
    expect(JSON.stringify(result)).not.toContain('/Users/someone')
  })
})

describe('getCursorCliAuthPath', () => {
  // Why: these mirror cursor-agent's own auth-file resolution so Orca reads the same file the CLI writes.
  const home = '/home/testuser'

  it('uses ~/.cursor/auth.json on darwin', () => {
    expect(getCursorCliAuthPath('darwin', home, {})).toBe(join(home, '.cursor', 'auth.json'))
  })

  it('uses %APPDATA%\\Cursor\\auth.json on win32', () => {
    expect(
      getCursorCliAuthPath('win32', home, { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' })
    ).toBe(join('C:\\Users\\test\\AppData\\Roaming', 'Cursor', 'auth.json'))
  })

  it('falls back to ~/AppData/Roaming on win32 when APPDATA is unset', () => {
    expect(getCursorCliAuthPath('win32', home, {})).toBe(
      join(home, 'AppData', 'Roaming', 'Cursor', 'auth.json')
    )
  })

  it('uses ~/.config/cursor/auth.json on Linux by default', () => {
    expect(getCursorCliAuthPath('linux', home, {})).toBe(
      join(home, '.config', 'cursor', 'auth.json')
    )
  })

  it('honors XDG_CONFIG_HOME on Linux', () => {
    expect(getCursorCliAuthPath('linux', home, { XDG_CONFIG_HOME: '/custom/config' })).toBe(
      join('/custom/config', 'cursor', 'auth.json')
    )
  })
})
