import { describe, expect, it } from 'vitest'
import { verifyWslAccountParticipation } from './verify-wsl-account-participation.mjs'

function report() {
  return {
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: 'C:\\orca\\src\\main\\antigravity\\native-wsl-accounts.wsl.test.ts',
        status: 'passed',
        assertionResults: [
          {
            title:
              'saves, selects, checks launch and removes synthetic accounts without changing normal HOME',
            status: 'passed'
          },
          { title: 'keeps a second explicit distro unchanged', status: 'passed' }
        ]
      }
    ]
  }
}

describe('WSL account participation', () => {
  it('accepts both real account scenarios on Windows and POSIX report paths', () => {
    const value = report()
    expect(() => verifyWslAccountParticipation(value)).not.toThrow()
    value.testResults[0].name = '/orca/src/main/antigravity/native-wsl-accounts.wsl.test.ts'
    expect(() => verifyWslAccountParticipation(value)).not.toThrow()
  })

  it.each(['numFailedTests', 'numPendingTests', 'numTodoTests'])(
    'rejects a nonzero %s count',
    (key) => {
      const value = report()
      value[key] = 1
      expect(() => verifyWslAccountParticipation(value)).toThrow('participation failed')
    }
  )

  it.each(['skipped', 'failed', 'todo'])('rejects a %s scenario despite pass totals', (status) => {
    const value = report()
    value.testResults[0].assertionResults[1].status = status
    expect(() => verifyWslAccountParticipation(value)).toThrow('participation failed')
  })

  it('rejects missing, duplicate or unrelated scenarios despite pass totals', () => {
    for (const title of [
      '',
      'unrelated account test',
      report().testResults[0].assertionResults[0].title
    ]) {
      const value = report()
      value.testResults[0].assertionResults[1].title = title
      expect(() => verifyWslAccountParticipation(value)).toThrow('participation failed')
    }
    const value = report()
    value.testResults[0].assertionResults.pop()
    expect(() => verifyWslAccountParticipation(value)).toThrow('participation failed')
  })

  it('rejects a missing report, collection failure or unrelated suite', () => {
    expect(() => verifyWslAccountParticipation({})).toThrow('participation failed')
    const failed = report()
    failed.testResults[0].status = 'failed'
    expect(() => verifyWslAccountParticipation(failed)).toThrow('participation failed')
    const unrelated = report()
    unrelated.testResults[0].name = '/orca/other.test.ts'
    expect(() => verifyWslAccountParticipation(unrelated)).toThrow('participation failed')
  })
})
