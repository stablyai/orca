import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Repo } from '../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { findProjectAtSameRealPath } from './project-realpath-identity'

export async function ensureQuickChatFolder(userData: string, repos: readonly Repo[]) {
  const path = join(userData, 'chats')
  // Recursive mkdir validates existing paths too, and never replaces a file.
  await mkdir(path, { recursive: true })
  if (!(await stat(path)).isDirectory()) {
    throw new Error('Quick chat path is not a directory')
  }
  const existing = await findProjectAtSameRealPath(
    repos.filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID),
    path
  )
  return { path, repoId: existing?.id }
}
