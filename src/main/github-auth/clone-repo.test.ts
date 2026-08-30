import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const { lstatMock, cloneLocalRepoIntoDestinationMock, resolveGitHubTokenMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  cloneLocalRepoIntoDestinationMock: vi.fn(),
  resolveGitHubTokenMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ lstat: lstatMock }))
vi.mock('../ipc/repos/repo-clone-lifecycle', () => ({
  cloneLocalRepoIntoDestination: cloneLocalRepoIntoDestinationMock
}))
vi.mock('./connection', () => ({ resolveGitHubToken: resolveGitHubTokenMock }))

import { cloneGitHubAccountRepo } from './clone-repo'

const IS_WIN = process.platform === 'win32'
const DESTINATION = IS_WIN ? 'C:\\Users\\dev\\orca\\projects' : '/Users/dev/orca/projects'
const CLONE_PATH = IS_WIN ? `${DESTINATION}\\my-repo` : `${DESTINATION}/my-repo`
const CLONE_URL = 'https://github.com/octo/my-repo'

const mainWindowStub = {} as never
const storeStub = {} as never

const baseArgs = {
  fullName: 'octo/my-repo',
  cloneUrl: CLONE_URL,
  isPrivate: false,
  destination: DESTINATION
}

beforeEach(() => {
  lstatMock.mockReset()
  cloneLocalRepoIntoDestinationMock.mockReset()
  resolveGitHubTokenMock.mockReset()
})

describe('cloneGitHubAccountRepo', () => {
  it('clones when the target directory does not exist yet', async () => {
    lstatMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    const repo = { id: 'r1', path: CLONE_PATH } as Repo
    cloneLocalRepoIntoDestinationMock.mockResolvedValue(repo)

    const result = await cloneGitHubAccountRepo(mainWindowStub, storeStub, baseArgs)

    expect(result).toEqual({ ok: true, repo })
    expect(cloneLocalRepoIntoDestinationMock).toHaveBeenCalledWith(
      mainWindowStub,
      storeStub,
      { url: CLONE_URL, destination: DESTINATION },
      { extraGitConfig: undefined }
    )
  })

  it('aborts with a clear error when a same-named directory already exists', async () => {
    lstatMock.mockResolvedValue({ isDirectory: () => true })

    const result = await cloneGitHubAccountRepo(mainWindowStub, storeStub, baseArgs)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(CLONE_PATH)
      expect(result.error).toContain('already exists')
    }
    expect(cloneLocalRepoIntoDestinationMock).not.toHaveBeenCalled()
  })

  it('rejects non-GitHub clone URLs before touching the filesystem', async () => {
    const result = await cloneGitHubAccountRepo(mainWindowStub, storeStub, {
      ...baseArgs,
      cloneUrl: 'https://example.com/octo/my-repo'
    })

    expect(result).toEqual({ ok: false, error: 'Invalid GitHub clone request.' })
    expect(lstatMock).not.toHaveBeenCalled()
    expect(cloneLocalRepoIntoDestinationMock).not.toHaveBeenCalled()
  })

  it('requires a connected account for private repositories', async () => {
    lstatMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    resolveGitHubTokenMock.mockReturnValue(null)

    const result = await cloneGitHubAccountRepo(mainWindowStub, storeStub, {
      ...baseArgs,
      isPrivate: true
    })

    expect(result.ok).toBe(false)
    expect(cloneLocalRepoIntoDestinationMock).not.toHaveBeenCalled()
  })

  it('passes a one-shot auth header for private clones, never embedding the token', async () => {
    lstatMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    resolveGitHubTokenMock.mockReturnValue('secret-token')
    const repo = { id: 'r1', path: CLONE_PATH } as Repo
    cloneLocalRepoIntoDestinationMock.mockResolvedValue(repo)

    const result = await cloneGitHubAccountRepo(mainWindowStub, storeStub, {
      ...baseArgs,
      isPrivate: true
    })

    expect(result).toEqual({ ok: true, repo })
    const options = cloneLocalRepoIntoDestinationMock.mock.calls[0][3] as {
      extraGitConfig: string[]
    }
    expect(options.extraGitConfig).toHaveLength(1)
    expect(options.extraGitConfig[0]).toMatch(/^http\.https:\/\/github\.com\/\.extraheader=/)
    expect(options.extraGitConfig[0]).not.toContain('secret-token')
  })
})
