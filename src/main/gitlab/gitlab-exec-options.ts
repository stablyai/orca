import type { LocalGitExecOptions } from './gitlab-known-host-probe'
import type { ProjectRef } from './project-ref-parser'

export function glabRepoExecOptions(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): { cwd?: string; wslDistro?: string } {
  return connectionId
    ? {}
    : {
        cwd: repoPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
      }
}

export function glabHostnameArgs(
  projectRef: Pick<ProjectRef, 'host'> | null | undefined,
  connectionId?: string | null
): string[] {
  return connectionId && projectRef?.host ? ['--hostname', projectRef.host] : []
}
