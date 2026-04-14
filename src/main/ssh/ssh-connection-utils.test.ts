import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('os', () => ({
  homedir: () => '/home/testuser'
}))

const mockExistsSync = vi.fn().mockReturnValue(false)
const mockReadFileSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args)
}))

import {
  isTransientError,
  sleep,
  shellEscape,
  findDefaultKeyFile,
  CONNECT_TIMEOUT_MS,
  INITIAL_RETRY_ATTEMPTS,
  INITIAL_RETRY_DELAY_MS,
  RECONNECT_BACKOFF_MS,
  AUTH_CHALLENGE_TIMEOUT_MS
} from './ssh-connection-utils'

// ── Constants ────────────────────────────────────────────────────────

describe('SSH connection constants', () => {
  it('CONNECT_TIMEOUT_MS is 30 seconds (matches VS Code)', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(30_000)
  })

  it('AUTH_CHALLENGE_TIMEOUT_MS is 60 seconds', () => {
    expect(AUTH_CHALLENGE_TIMEOUT_MS).toBe(60_000)
  })

  it('INITIAL_RETRY_ATTEMPTS is 5', () => {
    expect(INITIAL_RETRY_ATTEMPTS).toBe(5)
  })

  it('INITIAL_RETRY_DELAY_MS is 2 seconds', () => {
    expect(INITIAL_RETRY_DELAY_MS).toBe(2000)
  })

  it('RECONNECT_BACKOFF_MS has 9 entries', () => {
    expect(RECONNECT_BACKOFF_MS).toHaveLength(9)
  })
})

// ── isTransientError ─────────────────────────────────────────────────

describe('isTransientError', () => {
  it('returns true for ETIMEDOUT code', () => {
    const err = new Error('timed out') as NodeJS.ErrnoException
    err.code = 'ETIMEDOUT'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ECONNREFUSED code', () => {
    const err = new Error('refused') as NodeJS.ErrnoException
    err.code = 'ECONNREFUSED'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ECONNRESET code', () => {
    const err = new Error('reset') as NodeJS.ErrnoException
    err.code = 'ECONNRESET'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for EHOSTUNREACH code', () => {
    const err = new Error('host unreachable') as NodeJS.ErrnoException
    err.code = 'EHOSTUNREACH'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ENETUNREACH code', () => {
    const err = new Error('net unreachable') as NodeJS.ErrnoException
    err.code = 'ENETUNREACH'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for EAI_AGAIN code', () => {
    const err = new Error('dns') as NodeJS.ErrnoException
    err.code = 'EAI_AGAIN'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ETIMEDOUT in message (no code)', () => {
    expect(isTransientError(new Error('connect ETIMEDOUT 1.2.3.4:22'))).toBe(true)
  })

  it('returns true for ECONNREFUSED in message', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED 1.2.3.4:22'))).toBe(true)
  })

  it('returns true for ECONNRESET in message', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('returns false for auth errors', () => {
    expect(isTransientError(new Error('All configured authentication methods failed'))).toBe(false)
  })

  it('returns false for generic errors', () => {
    expect(isTransientError(new Error('something went wrong'))).toBe(false)
  })
})

// ── sleep ────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})

// ── shellEscape ──────────────────────────────────────────────────────

describe('shellEscape', () => {
  it('wraps string in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'")
  })

  it('handles empty string', () => {
    expect(shellEscape('')).toBe("''")
  })

  it('handles special characters', () => {
    expect(shellEscape('foo bar; rm -rf /')).toBe("'foo bar; rm -rf /'")
  })
})

// ── findDefaultKeyFile ───────────────────────────────────────────────

describe('findDefaultKeyFile', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
  })

  it('returns undefined when no default keys exist', () => {
    expect(findDefaultKeyFile()).toBeUndefined()
  })

  it('returns the first existing key file', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      return path === '/home/testuser/.ssh/id_ed25519'
    })
    mockReadFileSync.mockReturnValue(Buffer.from('key-contents'))

    const result = findDefaultKeyFile()
    expect(result).toBeDefined()
    expect(result!.path).toBe('~/.ssh/id_ed25519')
    expect(result!.contents).toEqual(Buffer.from('key-contents'))
  })

  it('probes keys in VS Code order: ed25519, rsa, ecdsa, dsa, xmss', () => {
    const checkedPaths: string[] = []
    mockExistsSync.mockImplementation((path: unknown) => {
      checkedPaths.push(String(path))
      return false
    })

    findDefaultKeyFile()

    expect(checkedPaths).toEqual([
      '/home/testuser/.ssh/id_ed25519',
      '/home/testuser/.ssh/id_rsa',
      '/home/testuser/.ssh/id_ecdsa',
      '/home/testuser/.ssh/id_dsa',
      '/home/testuser/.ssh/id_xmss'
    ])
  })

  it('skips unreadable key files and tries next', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      return path === '/home/testuser/.ssh/id_ed25519' || path === '/home/testuser/.ssh/id_rsa'
    })
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path) === '/home/testuser/.ssh/id_ed25519') {
        throw new Error('permission denied')
      }
      return Buffer.from('rsa-key')
    })

    const result = findDefaultKeyFile()
    expect(result).toBeDefined()
    expect(result!.path).toBe('~/.ssh/id_rsa')
  })
})
