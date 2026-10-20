import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { reportNewGitRepository } from './new-git-repository-observer'

const WARNING = '[repository-registration] new-repository observer failed'

function gitRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: '#22c55e',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'runtime:env-1'
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('reportNewGitRepository', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => warn.mockClear())

  it('logs only the fixed warning when the observer throws', () => {
    reportNewGitRepository(() => {
      throw new Error('secret-script-text')
    }, gitRepo())

    expect(warn.mock.calls).toEqual([[WARNING]])
  })

  it('logs only the fixed warning when the observer rejects', async () => {
    reportNewGitRepository(() => Promise.reject(new Error('secret-script-text')), gitRepo())
    await flush()

    expect(warn.mock.calls).toEqual([[WARNING]])
  })

  it('logs only the fixed warning when a custom thenable rejects', async () => {
    const thenable: PromiseLike<void> = {
      // oxlint-disable-next-line unicorn/no-thenable -- the test needs a non-Promise thenable.
      then: (onFulfilled, onRejected) =>
        Promise.reject(new Error('secret-script-text')).then(onFulfilled, onRejected)
    }
    reportNewGitRepository(() => thenable, gitRepo())
    await flush()

    expect(warn.mock.calls).toEqual([[WARNING]])
  })

  it('does not warn when the observer succeeds', async () => {
    reportNewGitRepository(() => Promise.resolve(), gitRepo())
    await flush()

    expect(warn).not.toHaveBeenCalled()
  })

  it('hands the observer a copy so identity mutations never reach the stored row', () => {
    const stored = gitRepo()
    reportNewGitRepository((repo) => {
      repo.id = 'other'
      repo.path = '/elsewhere'
      repo.kind = 'folder'
      repo.executionHostId = 'local'
    }, stored)

    expect(stored).toEqual(gitRepo())
  })

  it('does not call the observer for a folder row', () => {
    const observer = vi.fn()
    reportNewGitRepository(observer, { ...gitRepo(), kind: 'folder' })

    expect(observer).not.toHaveBeenCalled()
  })
})
