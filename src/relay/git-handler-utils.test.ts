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
})
