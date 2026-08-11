import { describe, expect, it } from 'vitest'
import { isUnsupportedWorktreeListZError, parseWorktreeList } from './git-handler-utils'

describe('parseWorktreeList', () => {
  it('preserves SSH worktree lock metadata from porcelain output', () => {
    expect(
      parseWorktreeList(
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /locked\nHEAD def\nbranch refs/heads/feature\nlocked remote session\n'
      )[1]
    ).toMatchObject({
      path: '/locked',
      locked: true,
      lockReason: 'remote session'
    })
  })

  it('decodes C-quoted lock reasons from legacy line porcelain output', () => {
    const output =
      'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /locked\nHEAD def\nbranch refs/heads/feature\nlocked "first line\\nsecond line \\303\\251"\n'

    expect(parseWorktreeList(output)[1]).toMatchObject({
      locked: true,
      lockReason: 'first line\nsecond line é'
    })
  })

  it('keeps NUL-delimited lock reasons raw', () => {
    const output = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /locked',
      'HEAD def',
      'branch refs/heads/feature',
      'locked "literal\\nquote"',
      ''
    ].join('\0')

    expect(parseWorktreeList(output, { nulDelimited: true })[1]).toMatchObject({
      locked: true,
      lockReason: '"literal\\nquote"'
    })
  })

  it('preserves a prunable marker and its reason', () => {
    expect(
      parseWorktreeList(
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /stale\nHEAD def\nbranch refs/heads/feature\nprunable gitdir file points to non-existent location\n'
      )[1]
    ).toMatchObject({
      path: '/stale',
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location'
    })
  })

  it('preserves a NUL-delimited prunable marker', () => {
    const output = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /stale',
      'HEAD def',
      'branch refs/heads/feature',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\0')

    expect(parseWorktreeList(output, { nulDelimited: true })[1]).toMatchObject({
      path: '/stale',
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location'
    })
  })
})

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
