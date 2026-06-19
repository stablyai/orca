import { describe, expect, it } from 'vitest'
import { parseStatusOutput } from './git-status-output-parser'

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
