import { describe, expect, it } from 'vitest'
import { isUnsupportedWorktreeListZError } from './git-handler-utils'

describe('isUnsupportedWorktreeListZError', () => {
  it('detects an unknown-switch usage error from stderr when the exit code is absent', () => {
    // Isolates the regex fallback: no numeric code, so only the stderr text
    // (a runner that dropped the exit code) can classify the rejection.
    const error = Object.assign(new Error('worktree list -z'), {
      stderr: "error: unknown switch `z'\nusage: git worktree list [<options>]\n"
    })
    expect(isUnsupportedWorktreeListZError(error)).toBe(true)
  })

  it('detects a localized (non-English) usage error via exit code 129', () => {
    // The SSH remote may run under a non-English locale where the stderr text is
    // translated; the numeric exit code must still classify the -z rejection.
    const error = Object.assign(new Error('worktree list -z'), {
      code: 129,
      stderr: 'Fehler: Unbekannter Schalter »z«\nAufruf: git worktree list [<Optionen>]\n'
    })
    expect(isUnsupportedWorktreeListZError(error)).toBe(true)
  })

  it('does not classify a fatal (exit 128) error as an unsupported -z rejection', () => {
    const error = Object.assign(new Error('fatal'), {
      code: 128,
      stderr: 'fatal: unable to read tree\n'
    })
    expect(isUnsupportedWorktreeListZError(error)).toBe(false)
  })
})
