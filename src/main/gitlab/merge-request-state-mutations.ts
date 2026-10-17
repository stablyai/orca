import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  acquire,
  glabHostEnvOptions,
  glabRepoExecOptions,
  glabExecFileAsync,
  release,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { withProjectRef } from './merge-request-project-resolution'

// Why: glab's MRCheckErrors refuses a no-op state change with these texts; any other failure,
// including its "has already been merged" refusal, must surface.
const GLAB_MR_ALREADY_CLOSED = /\bthis merge request has been closed\b/i
const GLAB_MR_ALREADY_OPEN = /\bthis merge request is already open\b/i

export async function closeMR(
  repoPath: string,
  iid: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef, repoFlag) => {
      await acquire()
      try {
        await glabExecFileAsync(['mr', 'close', String(iid), '-R', repoFlag], {
          ...glabRepoExecOptions(repoPath, connectionId, localGitOptions),
          ...glabHostEnvOptions(projectRef, connectionId)
        })
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (GLAB_MR_ALREADY_CLOSED.test(msg)) {
          return { ok: true }
        }
        return { ok: false, error: msg }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function reopenMR(
  repoPath: string,
  iid: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef, repoFlag) => {
      await acquire()
      try {
        await glabExecFileAsync(['mr', 'reopen', String(iid), '-R', repoFlag], {
          ...glabRepoExecOptions(repoPath, connectionId, localGitOptions),
          ...glabHostEnvOptions(projectRef, connectionId)
        })
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (GLAB_MR_ALREADY_OPEN.test(msg)) {
          return { ok: true }
        }
        return { ok: false, error: msg }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}

export async function mergeMR(
  repoPath: string,
  iid: number,
  method: 'merge' | 'squash' | 'rebase' = 'merge',
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withProjectRef<{ ok: true } | { ok: false; error: string }>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef, repoFlag) => {
      await acquire()
      try {
        // Why: omitting both --squash and --rebase yields a regular merge commit.
        const methodFlag =
          method === 'squash' ? ['--squash'] : method === 'rebase' ? ['--rebase'] : []
        await glabExecFileAsync(
          ['mr', 'merge', String(iid), '-R', repoFlag, '--yes', ...methodFlag],
          {
            ...glabRepoExecOptions(repoPath, connectionId, localGitOptions),
            ...glabHostEnvOptions(projectRef, connectionId)
          }
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        release()
      }
    },
    { ok: false, error: 'Could not resolve GitLab project for this repository' },
    localGitOptions
  )
}
