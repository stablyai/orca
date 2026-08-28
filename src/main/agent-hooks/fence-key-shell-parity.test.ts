import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fenceKeyFor } from './pretool-fence-sentinel'

// The shell reader is byte-oriented; fenceKeyFor must agree byte-for-byte or the
// glob misses the sentinel and the offline fence fails OPEN.
function shellKey(worktreeId: string): string {
  return execFileSync(
    '/usr/bin/env',
    [
      '-i',
      '/bin/sh',
      '-c',
      `printf %s "$1" | tail -c 64 | tr -c 'A-Za-z0-9._-' '_'`,
      'sh',
      worktreeId
    ],
    { encoding: 'latin1' }
  )
}

describe.skipIf(process.platform === 'win32')('fence key agrees with the shell reader', () => {
  it('agrees on a non-ASCII worktree path', () => {
    const id = 'id:repo::/Users/jonathan/café/wt'
    expect(fenceKeyFor(id)).toBe(shellKey(id))
  })
  it('agrees on a CJK worktree path', () => {
    const id = 'id:repo::/Users/j/作業ツリー/main'
    expect(fenceKeyFor(id)).toBe(shellKey(id))
  })
  it('still agrees on a plain ASCII path', () => {
    const id = 'id:repo::/Users/j/orca/wt-a'
    expect(fenceKeyFor(id)).toBe(shellKey(id))
  })
})
