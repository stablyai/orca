import { describe, expect, it } from 'vitest'
import {
  SshDirectoryTransferBudget,
  type SshDirectoryTransferLimits
} from './ssh-directory-transfer-budget'

const limits: SshDirectoryTransferLimits = {
  maximumEntries: 2,
  maximumDepth: 2,
  maximumPathBytes: 4,
  maximumRetainedPathBytes: 8,
  maximumFileBytes: 4,
  maximumTotalFileBytes: 8
}

describe('SshDirectoryTransferBudget', () => {
  it('accepts every exact boundary', () => {
    const budget = new SshDirectoryTransferBudget(limits)

    budget.recordPath('1234', 2)
    budget.recordPath('5678', 2)
    budget.recordFile(4)
    budget.recordFile(4)
  })

  it.each([
    ['entries', (budget: SshDirectoryTransferBudget) => budget.recordPath('', 0)],
    ['depth', (budget: SshDirectoryTransferBudget) => budget.recordPath('', 3)],
    ['path', (budget: SshDirectoryTransferBudget) => budget.recordPath('12345', 0)],
    [
      'paths',
      (budget: SshDirectoryTransferBudget) => budget.recordPath('1', 0, { countEntry: false })
    ],
    ['file', (budget: SshDirectoryTransferBudget) => budget.recordFile(5)],
    ['files', (budget: SshDirectoryTransferBudget) => budget.recordFile(1)]
  ] as const)('rejects one unit beyond the %s boundary', (reason, exceed) => {
    const budget = new SshDirectoryTransferBudget(limits)
    if (reason === 'entries') {
      budget.recordPath('', 0)
      budget.recordPath('', 0)
    } else if (reason === 'paths') {
      budget.recordPath('1234', 0, { countEntry: false })
      budget.recordPath('5678', 0, { countEntry: false })
    } else if (reason === 'files') {
      budget.recordFile(4)
      budget.recordFile(4)
    }

    expect(() => exceed(budget)).toThrow(expect.objectContaining({ reason }))
  })
})
