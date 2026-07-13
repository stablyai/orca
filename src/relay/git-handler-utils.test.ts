import { describe, expect, it } from 'vitest'
import { parseStatusOutput } from './git-status-output-parser'
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

describe('parseStatusOutput', () => {
  it('parses upstream ahead/behind from porcelain v2 branch headers', () => {
    const result = parseStatusOutput(
      [
        '# branch.oid abcdef1234567890',
        '# branch.head feature/prompts',
        '# branch.upstream origin/feature/prompts',
        '# branch.ab +2 -3',
        ''
      ].join('\n')
    )

    expect(result.upstreamStatus).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature/prompts',
      ahead: 2,
      behind: 3
    })
  })

  it('reports no upstream when porcelain v2 omits branch.upstream', () => {
    const result = parseStatusOutput(
      ['# branch.oid abcdef1234567890', '# branch.head feature/prompts', ''].join('\n')
    )

    expect(result.upstreamStatus).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
  })

  it('parses ignored porcelain records separately from actionable entries', () => {
    const result = parseStatusOutput(['! dist/', '! .env', '? scratch.txt', ''].join('\n'))

    expect(result.ignoredPaths).toEqual(['dist/', '.env'])
    expect(result.entries).toEqual([
      { path: 'scratch.txt', status: 'untracked', area: 'untracked' }
    ])
  })

  it('parses rename records with spaces in the paths', () => {
    const result = parseStatusOutput(
      '2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new name.ts\tsrc/old name.ts\n'
    )

    expect(result.entries).toEqual([
      { path: 'src/new name.ts', oldPath: 'src/old name.ts', status: 'renamed', area: 'staged' }
    ])
  })

  it('parses submodule dirtiness flags from porcelain records', () => {
    const result = parseStatusOutput(
      '1 AM S..U 000000 160000 160000 0000000000000000000000000000000000000000 7844cb64e631f17a9ca5b548f3500ef7cecd2f17 nested-repo\n'
    )

    expect(result.entries).toEqual([
      {
        path: 'nested-repo',
        status: 'added',
        area: 'staged',
        submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }
      },
      {
        path: 'nested-repo',
        status: 'modified',
        area: 'unstaged',
        submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }
      }
    ])
  })
})
