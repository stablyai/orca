import { describe, expect, it } from 'vitest'
import {
  hasOpSecretReferences,
  maybeWrapStartupCommandWithOpRun,
  wrapStartupCommandWithOpRun
} from './op-run-secret-injection'

describe('hasOpSecretReferences', () => {
  it('detects op:// values', () => {
    expect(hasOpSecretReferences({ KEY: 'op://Private/Item/field' })).toBe(true)
  })

  it('is false for plain values, empty env, and undefined', () => {
    expect(hasOpSecretReferences({ KEY: 'plain', URL: 'https://op.example' })).toBe(false)
    expect(hasOpSecretReferences({})).toBe(false)
    expect(hasOpSecretReferences(undefined)).toBe(false)
  })
})

describe('wrapStartupCommandWithOpRun', () => {
  it('prefixes simple commands', () => {
    expect(wrapStartupCommandWithOpRun('claude', 'darwin')).toBe('op run -- claude')
    expect(wrapStartupCommandWithOpRun('claude --resume abc', 'linux')).toBe(
      'op run -- claude --resume abc'
    )
  })

  it('wraps chained commands in sh -c so every segment stays inside op run', () => {
    expect(wrapStartupCommandWithOpRun('npm i && claude', 'darwin')).toBe(
      "op run -- sh -c 'npm i && claude'"
    )
  })

  it('escapes embedded single quotes in sh -c wrapping', () => {
    expect(wrapStartupCommandWithOpRun("echo 'hi' && claude", 'linux')).toBe(
      `op run -- sh -c 'echo '\\''hi'\\'' && claude'`
    )
  })

  it('leaves chained commands untouched on Windows (no portable quoting)', () => {
    expect(wrapStartupCommandWithOpRun('npm i && claude', 'win32')).toBe('npm i && claude')
    expect(wrapStartupCommandWithOpRun('claude', 'win32')).toBe('op run -- claude')
  })

  it('treats newline-separated commands as chained', () => {
    expect(wrapStartupCommandWithOpRun('npm i\nclaude', 'linux')).toBe(
      "op run -- sh -c 'npm i\nclaude'"
    )
    expect(wrapStartupCommandWithOpRun('npm i\r\nclaude', 'win32')).toBe('npm i\r\nclaude')
  })
})

describe('maybeWrapStartupCommandWithOpRun', () => {
  const env = { ANTHROPIC_API_KEY: 'op://Private/Anthropic/api-key' }

  it('wraps when enabled, local, refs present, and a command exists', () => {
    expect(
      maybeWrapStartupCommandWithOpRun('claude', env, { enabled: true, connectionId: null })
    ).toBe('op run -- claude')
  })

  it('passes through when disabled', () => {
    expect(
      maybeWrapStartupCommandWithOpRun('claude', env, { enabled: false, connectionId: null })
    ).toBe('claude')
  })

  it('sh -c wraps metachar commands for WSL targets on a Windows host', () => {
    // Why: a WSL PTY runs a POSIX shell, so the caller passes 'linux' despite process.platform being win32.
    expect(
      maybeWrapStartupCommandWithOpRun('npm install && claude', env, {
        enabled: true,
        connectionId: null,
        platform: 'linux'
      })
    ).toBe("op run -- sh -c 'npm install && claude'")
  })

  it('never rewrites remote spawns', () => {
    expect(
      maybeWrapStartupCommandWithOpRun('claude', env, { enabled: true, connectionId: 'ssh-1' })
    ).toBe('claude')
  })

  it('passes through when the env has no refs', () => {
    expect(
      maybeWrapStartupCommandWithOpRun(
        'claude',
        { KEY: 'plain' },
        {
          enabled: true,
          connectionId: null
        }
      )
    ).toBe('claude')
  })

  it('passes through undefined and blank commands', () => {
    expect(
      maybeWrapStartupCommandWithOpRun(undefined, env, { enabled: true, connectionId: null })
    ).toBeUndefined()
    expect(maybeWrapStartupCommandWithOpRun('  ', env, { enabled: true, connectionId: null })).toBe(
      '  '
    )
  })
})
