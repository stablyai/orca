// Why: covers two recent classifier fixes — Retry-After honoring on 429
// (transient detection must propagate, not silently retry on 250ms cadence)
// and stderr extraction from execFile rejections (err.message is unreliable).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendGitConfigEnv,
  extractExecError,
  isTransientGhError,
  nonInteractiveGitEnv,
  parseRetryAfterMs,
  promptGuardGitEnv,
  promptGuardShellEnv,
  redirectPortedHostnameToEnv,
  untranslatedGitOutputEnv
} from './runner'
import { mergeGitConfigEnvProtocol } from '../../shared/git-credential-prompt-env'

// Reads git config injected via the GIT_CONFIG_COUNT/KEY/VALUE env protocol
// back into a plain key→value map so tests can assert on it directly.
function readGitConfigEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10)
  const config: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`]
    const value = env[`GIT_CONFIG_VALUE_${i}`]
    if (key !== undefined && value !== undefined) {
      config[key] = value
    }
  }
  return config
}

describe('redirectPortedHostnameToEnv', () => {
  it('moves a ported --hostname into GITLAB_HOST and strips the flag', () => {
    const { args, options } = redirectPortedHostnameToEnv(
      ['api', '--hostname', 'gitlab.example.com:8443', 'projects/foo%2Fbar/issues'],
      { cwd: '/repo' }
    )
    expect(args).toEqual(['api', 'projects/foo%2Fbar/issues'])
    expect(options.env?.GITLAB_HOST).toBe('gitlab.example.com:8443')
    expect(options.cwd).toBe('/repo')
  })

  it('leaves a port-less --hostname untouched', () => {
    const input = ['api', '--hostname', 'gitlab.com', 'user']
    const { args, options } = redirectPortedHostnameToEnv(input, {})
    expect(args).toEqual(input)
    expect(options.env).toBeUndefined()
  })

  it('is a no-op when no --hostname is present', () => {
    const input = ['auth', 'status']
    const { args, options } = redirectPortedHostnameToEnv(input, { env: { A: '1' } })
    expect(args).toEqual(input)
    expect(options.env).toEqual({ A: '1' })
  })

  it('preserves existing env entries alongside GITLAB_HOST', () => {
    const { options } = redirectPortedHostnameToEnv(
      ['auth', 'status', '--hostname', 'gl.example.org:3001'],
      { env: { PATH: '/usr/bin' } }
    )
    expect(options.env?.PATH).toBe('/usr/bin')
    expect(options.env?.GITLAB_HOST).toBe('gl.example.org:3001')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseRetryAfterMs', () => {
  it('returns null when no Retry-After is present', () => {
    expect(parseRetryAfterMs('HTTP 429 Too Many Requests')).toBeNull()
  })

  it('parses integer seconds', () => {
    expect(parseRetryAfterMs('HTTP 429\nRetry-After: 30\n')).toBe(30_000)
  })

  it('handles case-insensitive header name and surrounding whitespace', () => {
    expect(parseRetryAfterMs('  retry-after:   12  \n')).toBe(12_000)
  })

  it('parses large stderr output without full-string retry-after matching', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const stderr = `${'noise\n'.repeat(10_000)}Retry-After: 12\n`

    expect(parseRetryAfterMs(stderr)).toBe(12_000)
    const usedRetryAfterMatch = matchSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        pattern.source.startsWith('retry-after:') &&
        pattern.source.includes('[^\\r\\n]')
    )
    expect(usedRetryAfterMatch).toBe(false)
  })

  it('returns null for malformed values', () => {
    expect(parseRetryAfterMs('Retry-After: not-a-date')).toBeNull()
  })
})

describe('isTransientGhError', () => {
  it('retries 5xx errors', () => {
    expect(isTransientGhError('HTTP 502 Bad Gateway')).toBe(true)
    expect(isTransientGhError('http 503')).toBe(true)
  })

  it('retries network resets', () => {
    expect(isTransientGhError('connect ECONNRESET 10.0.0.1:443')).toBe(true)
    expect(isTransientGhError('socket hang up')).toBe(true)
  })

  it('retries 429 without Retry-After', () => {
    expect(isTransientGhError('HTTP 429 Too Many Requests')).toBe(true)
  })

  it('does NOT retry 429 with Retry-After', () => {
    // Why: when GitHub returns Retry-After, the server is telling us how long
    // to wait. Retrying on our 250ms cadence just earns another 429 and burns
    // the retry budget.
    expect(isTransientGhError('HTTP 429 Too Many Requests\nRetry-After: 60\n')).toBe(false)
  })

  it("does NOT retry 4xx that aren't 429", () => {
    expect(isTransientGhError('HTTP 401 Unauthorized')).toBe(false)
    expect(isTransientGhError('HTTP 404 Not Found')).toBe(false)
    expect(isTransientGhError('HTTP 422 Unprocessable Entity')).toBe(false)
  })
})

describe('extractExecError', () => {
  it('reads stderr and stdout from explicit fields', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'real stderr content',
      stdout: '{"data": null}'
    })
    expect(extractExecError(err)).toEqual({
      stderr: 'real stderr content',
      stdout: '{"data": null}'
    })
  })

  it('decodes Buffer stderr/stdout', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from('buf-stderr', 'utf-8'),
      stdout: Buffer.from('buf-stdout', 'utf-8')
    })
    expect(extractExecError(err)).toEqual({
      stderr: 'buf-stderr',
      stdout: 'buf-stdout'
    })
  })

  it('falls back to err.message when stderr/stdout are absent', () => {
    const err = new Error('Some message')
    expect(extractExecError(err)).toEqual({
      stderr: 'Some message',
      stdout: ''
    })
  })

  it('handles non-Error rejections', () => {
    expect(extractExecError('plain string error')).toEqual({
      stderr: 'plain string error',
      stdout: ''
    })
  })
})

describe('appendGitConfigEnv', () => {
  it('injects entries starting at count 0 when none exist', () => {
    const env = appendGitConfigEnv({ PATH: '/usr/bin' }, [['credential.interactive', 'false']])
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(env.GIT_CONFIG_VALUE_0).toBe('false')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('composes with an existing count instead of clobbering caller config', () => {
    const env = appendGitConfigEnv(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotePath', GIT_CONFIG_VALUE_0: 'false' },
      [['credential.guiPrompt', 'false']]
    )
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    // Existing entry preserved.
    expect(env.GIT_CONFIG_KEY_0).toBe('core.quotePath')
    expect(env.GIT_CONFIG_VALUE_0).toBe('false')
    // New entry appended at the next index.
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.guiPrompt')
    expect(env.GIT_CONFIG_VALUE_1).toBe('false')
  })

  it.each(['bogus', '-1', '0', String(Number.MAX_SAFE_INTEGER)])(
    'does not overwrite dangling caller config when count is %s',
    (count) => {
      const original = {
        GIT_CONFIG_COUNT: count,
        GIT_CONFIG_KEY_0: 'user.key',
        GIT_CONFIG_VALUE_0: 'caller-value'
      }
      expect(appendGitConfigEnv(original, [['credential.interactive', 'false']])).toEqual(original)
    }
  )

  it('does not append to an incomplete indexed-config protocol', () => {
    const original = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.key' }
    expect(appendGitConfigEnv(original, [['credential.interactive', 'false']])).toEqual(original)
  })
})

describe('mergeGitConfigEnvProtocol', () => {
  it('replaces inherited indexed config atomically when an override has a smaller count', () => {
    const env = mergeGitConfigEnvProtocol(
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'base.zero',
        GIT_CONFIG_VALUE_0: 'zero',
        GIT_CONFIG_KEY_1: 'base.one',
        GIT_CONFIG_VALUE_1: 'one'
      },
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'override.zero',
        GIT_CONFIG_VALUE_0: 'override'
      }
    )

    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('override.zero')
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined()
  })
})

describe('promptGuardGitEnv credential-interactivity disable (STA-1292)', () => {
  it('disables the GCM GUI prompt without nuking the credential helper', () => {
    const env = promptGuardGitEnv({ PATH: '/usr/bin' })
    // GCM: never show the GUI, but still serve cached credentials.
    expect(env.GCM_INTERACTIVE).toBe('never')
    const config = readGitConfigEnv(env)
    expect(config['credential.interactive']).toBe('false')
    expect(config['credential.guiPrompt']).toBe('false')
    // Regression guard: we must NOT clear the helper — that would break
    // cached-credential auth for private repos.
    expect(config['credential.helper']).toBeUndefined()
    // Existing prompt guards remain intact.
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })
})

describe('nonInteractiveGitEnv credential-interactivity disable (STA-1292)', () => {
  it('carries the credential-interactivity disable through from promptGuardGitEnv', () => {
    const env = nonInteractiveGitEnv({ PATH: '/usr/bin' })
    expect(env.GCM_INTERACTIVE).toBe('never')
    const config = readGitConfigEnv(env)
    expect(config['credential.interactive']).toBe('false')
    expect(config['credential.guiPrompt']).toBe('false')
    expect(config['credential.helper']).toBeUndefined()
    // Its own BatchMode SSH guard is still applied and unaffected.
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
  })
})

describe('guard-env WSLENV forwarding (#7652)', () => {
  it('registers the guard vars in WSLENV on Windows so WSL-routed git imports them', () => {
    const env = promptGuardGitEnv({ PATH: '/usr/bin' }, 'win32')
    const keys = (env.WSLENV ?? '').split(':')
    expect(keys).toContain('GIT_TERMINAL_PROMPT')
    expect(keys).toContain('GCM_INTERACTIVE')
    expect(keys).toContain('GIT_CONFIG_COUNT')
    expect(keys).toContain('GIT_CONFIG_KEY_0')
    expect(keys).toContain('GIT_CONFIG_VALUE_0')
    expect(keys).toContain('GIT_CONFIG_KEY_1')
    expect(keys).toContain('GIT_CONFIG_VALUE_1')
    // Windows askpass paths are meaningless inside a distro.
    expect(keys).not.toContain('GIT_ASKPASS')
    expect(keys).not.toContain('SSH_ASKPASS')
  })

  it('preserves a caller-set WSLENV instead of clobbering it', () => {
    const env = promptGuardGitEnv({ PATH: '/usr/bin', WSLENV: 'MY_VAR/p' }, 'win32')
    const keys = (env.WSLENV ?? '').split(':')
    expect(keys[0]).toBe('MY_VAR/p')
    expect(keys).toContain('GIT_TERMINAL_PROMPT')
  })

  it('does not touch WSLENV on non-Windows hosts', () => {
    const env = promptGuardGitEnv({ PATH: '/usr/bin' }, 'darwin')
    expect(env.WSLENV).toBeUndefined()
  })

  it('forwards GIT_SSH_COMMAND only when nonInteractiveGitEnv set the default itself', () => {
    const defaulted = nonInteractiveGitEnv({ PATH: '/usr/bin' }, 'win32')
    expect((defaulted.WSLENV ?? '').split(':')).toContain('GIT_SSH_COMMAND')

    // A caller's Windows-specific ssh command must not leak into the distro.
    const callerSet = nonInteractiveGitEnv(
      { PATH: '/usr/bin', GIT_SSH_COMMAND: 'C:\\ssh\\ssh.exe' },
      'win32'
    )
    expect((callerSet.WSLENV ?? '').split(':')).not.toContain('GIT_SSH_COMMAND')
  })
})

describe('promptGuardShellEnv keeps the shell locale (#7652 x #7808)', () => {
  it('guards without pinning the locale — a terminal env is the whole shell, not just git', () => {
    const env = promptGuardShellEnv({ PATH: '/usr/bin', LC_ALL: 'ja_JP.UTF-8' }, 'win32')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect((env.WSLENV ?? '').split(':')).toContain('GIT_TERMINAL_PROMPT')
    // The user's locale survives; no pins appear where none existed.
    expect(env.LC_ALL).toBe('ja_JP.UTF-8')
    expect(env.LANG).toBeUndefined()
    expect(env.LANGUAGE).toBeUndefined()
  })
})

describe('git env forces untranslated diagnostics (issue #7808)', () => {
  it('overrides an inherited non-English locale so stderr parsers keep working', () => {
    // A gettext-enabled git under de_DE translates even the `fatal:` prefix,
    // breaking isNoUpstreamError and every other stderr phrase match.
    const env = promptGuardGitEnv({ PATH: '/usr/bin', LC_ALL: 'de_DE.UTF-8' })
    expect(env.LC_ALL).toBe('en_US.UTF-8')
    expect(env.LANG).toBe('en_US.UTF-8')
  })

  it('pins LANGUAGE, which outranks LC_ALL in gettext lookups', () => {
    const env = untranslatedGitOutputEnv({ PATH: '/usr/bin', LANGUAGE: 'de:en' })
    expect(env.LANGUAGE).toBe('en')
    expect(env.LC_ALL).toBe('en_US.UTF-8')
  })

  it('applies to nonInteractiveGitEnv as well', () => {
    const env = nonInteractiveGitEnv({ PATH: '/usr/bin', LANG: 'fr_FR.UTF-8' })
    expect(env.LC_ALL).toBe('en_US.UTF-8')
    expect(env.LANGUAGE).toBe('en')
  })
})
