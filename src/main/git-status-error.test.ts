import { describe, expect, it } from 'vitest'
import { gitStatusErrorMeansNotRepository } from './git-status-error'

describe('gitStatusErrorMeansNotRepository', () => {
  it('recognizes the Git status error from either message channel', () => {
    expect(gitStatusErrorMeansNotRepository('fatal: not a git repository')).toBe(true)
    expect(
      gitStatusErrorMeansNotRepository(
        Object.assign(new Error('status failed'), {
          stderr: 'fatal: not a git repository (or any of the parent directories): .git'
        })
      )
    ).toBe(true)
  })

  it('does not classify unrelated Git status failures as missing repositories', () => {
    expect(
      gitStatusErrorMeansNotRepository(
        Object.assign(new Error('status failed'), {
          stderr: 'fatal: unable to read current working directory'
        })
      )
    ).toBe(false)
  })
})
