import { describe, expect, it } from 'vitest'
import { WSL_CODEX_NOT_FOUND_MESSAGE } from '../codex-accounts/wsl-codex-command'
import { CodexAppServerTimeoutError } from './codex-app-server-client'
import { classifyCodexTrustGrantError } from './codex-trust-grant-telemetry'

describe('classifyCodexTrustGrantError', () => {
  it.each([
    [new CodexAppServerTimeoutError('entry exceeded 20000ms session deadline'), 'timeout'],
    [new Error('spawn codex ENOENT'), 'binary-missing'],
    [new Error('spawn /Users/ada/.local/bin/codex ENOENT'), 'binary-missing'],
    [
      new Error(
        `codex app-server exited before completing the session: ${WSL_CODEX_NOT_FOUND_MESSAGE}`
      ),
      'binary-missing'
    ],
    [new Error('spawn wsl.exe ENOENT'), 'unexpected'],
    [
      new Error("ENOENT: no such file or directory, open '/home/ada/.codex/config.toml'"),
      'unexpected'
    ],
    [new Error('codex trust-grant entry bundle not found'), 'entry-failed'],
    [new Error('codex trust-grant entry produced no result (exit 1)'), 'entry-failed'],
    [
      new Error('codex app-server exited before completing the session: panicked at main.rs'),
      'early-exit'
    ],
    [new Error('codex app-server config/batchWrite failed: unknown key'), 'rpc-failed'],
    [new Error('write EPIPE'), 'unexpected'],
    ['not an error object', 'unexpected']
  ] as const)('classifies %s as %s', (error, expected) => {
    expect(classifyCodexTrustGrantError(error)).toBe(expected)
  })

  it('keeps an ENOENT-mentioning stderr tail classified as early-exit', () => {
    expect(
      classifyCodexTrustGrantError(
        new Error('codex app-server exited before completing the session: ENOENT in codex output')
      )
    ).toBe('early-exit')
  })
})
