/**
 * Pins the raw-first parent resolution of createRemoteRepo: a picker-returned SSH
 * parent with a trailing space (legal POSIX name on the remote too) must be used as
 * typed when it exists, with the trim kept only for typed typos (#25386).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitProviderMock, fsProviderMock, addRemoteRepoFromPathMock } = vi.hoisted(() => ({
  gitProviderMock: {
    getHostPlatform: vi.fn(() => ({ pathFlavor: 'unix' }))
  },
  fsProviderMock: {
    stat: vi.fn(),
    readDir: vi.fn(),
    createDirNoClobber: vi.fn(async () => undefined),
    deletePath: vi.fn(async () => undefined)
  },
  addRemoteRepoFromPathMock: vi.fn()
}))

vi.mock('../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: () => gitProviderMock
}))

vi.mock('../../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: () => fsProviderMock
}))

vi.mock('./remote-repo-registration', () => ({
  addRemoteRepoFromPath: addRemoteRepoFromPathMock
}))

import { createRemoteRepo } from './remote-repo-creation'

const CONNECTION_ID = 'conn-1'
const ABSOLUTE_PARENT = '/srv/projects'

function makeStore(): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creation only reads getRepos() for the dedup checks stubbed here.
  return {
    getRepos: () => []
  } as never
}

describe('createRemoteRepo parent resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addRemoteRepoFromPathMock.mockResolvedValue({
      repo: { id: 'repo-1', path: '/target', connectionId: CONNECTION_ID },
      alreadyExisted: false
    })
  })

  it('creates inside a trailing-space remote parent that exists exactly as requested', async () => {
    const rawParent = `${ABSOLUTE_PARENT}/cloud dir `
    // The raw parent exists; the target itself does not.
    fsProviderMock.stat.mockImplementation((path: string) => {
      if (path === rawParent) {
        return Promise.resolve({})
      }
      return Promise.reject(new Error(`ENOENT: no such file or directory, stat '${path}'`))
    })
    const result = await createRemoteRepo(makeStore(), {
      connectionId: CONNECTION_ID,
      parentPath: rawParent,
      name: 'kid',
      kind: 'folder'
    })
    expect('error' in result && result.error).toBeFalsy()
    expect(fsProviderMock.createDirNoClobber).toHaveBeenCalledWith(
      `${ABSOLUTE_PARENT}/cloud dir /kid`
    )
  })

  it('falls back to the trimmed spelling when the raw remote parent does not exist', async () => {
    const requestedParent = `${ABSOLUTE_PARENT}/typo dir `
    fsProviderMock.stat.mockImplementation((path: string) => {
      if (path === `${ABSOLUTE_PARENT}/typo dir`) {
        return Promise.resolve({})
      }
      return Promise.reject(new Error(`ENOENT: no such file or directory, stat '${path}'`))
    })
    const result = await createRemoteRepo(makeStore(), {
      connectionId: CONNECTION_ID,
      parentPath: requestedParent,
      name: 'kid',
      kind: 'folder'
    })
    expect('error' in result && result.error).toBeFalsy()
    expect(fsProviderMock.createDirNoClobber).toHaveBeenCalledWith(
      `${ABSOLUTE_PARENT}/typo dir/kid`
    )
  })

  it('surfaces a non-absent probe failure instead of creating at the trimmed spelling', async () => {
    const rawParent = `${ABSOLUTE_PARENT}/cloud dir `
    fsProviderMock.stat.mockRejectedValue(
      new Error(`EACCES: permission denied, stat '${rawParent}'`)
    )
    const result = await createRemoteRepo(makeStore(), {
      connectionId: CONNECTION_ID,
      parentPath: rawParent,
      name: 'kid',
      kind: 'folder'
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toMatch(/Cannot access parent directory/)
    }
    expect(fsProviderMock.createDirNoClobber).not.toHaveBeenCalled()
  })
})
