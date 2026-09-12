import { describe, expect, it } from 'vitest'
import type { LinearIssueContextResult } from '../../shared/linear/agent-access'
import { formatRemoteLinearCli } from './ssh-remote-linear-output'

describe('SSH Linear cycle output', () => {
  const result = (cycle: unknown) =>
    ({
      issue: {
        id: 'issue-1',
        identifier: 'ENG-124',
        title: 'Show the cycle',
        url: 'https://linear.app/acme/issue/ENG-124',
        labels: [],
        cycle
      },
      meta: { includeErrors: [], sections: {} }
    }) as unknown as LinearIssueContextResult

  it('prints the same Cycle line as the bundled CLI in non-json issue output', () => {
    expect(
      formatRemoteLinearCli(result({ id: 'cycle-20', name: null, number: 20 }))?.stdout
    ).toContain('Cycle: 20')
    expect(
      formatRemoteLinearCli(result({ id: 'cycle-20', name: 'Launch week', number: 20 }))?.stdout
    ).toContain('Cycle: 20 (Launch week)')
    expect(formatRemoteLinearCli(result({ id: 'cycle-21', name: 'Named only' }))?.stdout).toContain(
      'Cycle: Named only'
    )
    expect(formatRemoteLinearCli(result(null))?.stdout).toContain('Cycle: none')
  })
})
