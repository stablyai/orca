import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeRemovalFailure } from '../../filesystem/host-tree-removal-failure'
import { failureLeftByGit } from './worktree-removal-failure'

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const worktreePath = join(tmpdir(), 'orca-missing-worktree-removal-failure')
const record = {
  worktreeId: 'repo::wt',
  repoId: 'repo',
  repoPath: join(tmpdir(), 'orca-missing-repo'),
  worktreePath,
  branch: 'feature',
  head: '',
  deleteBranch: false,
  force: false,
  requestedAt: 0
}

async function retryMessageFor(
  platform: NodeJS.Platform,
  code: string,
  syscall: string,
  path: string
): Promise<string | undefined> {
  Object.defineProperty(process, 'platform', { value: platform })
  const error = describeRemovalFailure(
    Object.assign(new Error(`${code}: ${syscall}`), { code, syscall, path })
  )
  return (await failureLeftByGit(record, error))?.message
}

describe('failureLeftByGit', () => {
  afterEach(() => hostPlatform && Object.defineProperty(process, 'platform', hostPlatform))

  it('adds the removed-folder retry guidance to every host delete failure', async () => {
    const retry = `, then retry deletion. If you removed the folder at ${worktreePath} yourself, retry deletion to finish cleanup.`
    expect(await retryMessageFor('linux', 'EACCES', 'unlink', '/w/sub/x.pyc')).toBe(
      `/w/sub/x.pyc could not be deleted: you do not have permission to change /w/sub (it may be owned by another user). Change its owner or permissions${retry}`
    )
    expect(await retryMessageFor('darwin', 'EPERM', 'unlink', '/w/locked.txt')).toBe(
      `/w/locked.txt could not be deleted; it may be locked or owned by another user. Unlock it or change its owner${retry}`
    )
    expect(await retryMessageFor('win32', 'EACCES', 'unlink', 'C:\\w\\x.pyc')).toBe(
      `C:\\w\\x.pyc could not be deleted; it may be read-only or open in another program. Close any program using it${retry}`
    )
    expect(await retryMessageFor('win32', 'EBUSY', 'rmdir', 'C:\\w\\sub')).toBe(
      `C:\\w\\sub is open in another program. Close that program${retry}`
    )
  })
})
