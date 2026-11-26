import { normalizeGitLabMergeMethodSettings } from '../../../shared/github/pull-requests/merge/pull-request-merge-methods'
import type { GitHubPRMergeMethodSettings } from '../../../shared/github/pull-requests/pull-request-types'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'
import { acquire, release } from '../requests/glab-request-admission'
import { getGlabKnownHosts, type LocalGitExecOptions } from './gitlab-known-host-probe'
import {
  getProjectRef,
  glabHostnameArgs,
  glabRepoExecOptions
} from './gitlab-project-ref-resolution'
import { encodedProject } from './project-path-encoding'

const SETTINGS_TTL_MS = 10 * 60 * 1000
const UNKNOWN_TTL_MS = 60 * 1000
const MAX_ENTRIES = 256

const cache = new Map<
  string,
  { value: GitHubPRMergeMethodSettings | undefined; expiresAt: number }
>()
const inflight = new Map<string, Promise<GitHubPRMergeMethodSettings | undefined>>()

/** Never throws: unreadable settings fall back to the unrestricted default. */
export async function getGitLabProjectMergeMethodSettings(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubPRMergeMethodSettings | undefined> {
  try {
    const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
    const projectRef = await getProjectRef(repoPath, knownHosts, connectionId, localGitOptions)
    if (!projectRef) {
      return undefined
    }
    const key = JSON.stringify([connectionId ?? null, projectRef.host, projectRef.path])
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }
    const pending = inflight.get(key)
    if (pending) {
      return await pending
    }
    const read = (async () => {
      let value: GitHubPRMergeMethodSettings | undefined
      let known = false
      await acquire()
      try {
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            `projects/${encodedProject(projectRef.path)}`
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        const project: { squash_option?: unknown; merge_method?: unknown } = JSON.parse(stdout)
        value = normalizeGitLabMergeMethodSettings({
          squashOption: project.squash_option,
          mergeMethod: project.merge_method
        })
        known = value !== undefined
      } catch {
        // Fall through to the short unknown TTL.
      } finally {
        release()
      }
      const oldest = cache.keys().next()
      if (cache.size >= MAX_ENTRIES && !oldest.done) {
        cache.delete(oldest.value)
      }
      cache.set(key, { value, expiresAt: Date.now() + (known ? SETTINGS_TTL_MS : UNKNOWN_TTL_MS) })
      return value
    })().finally(() => inflight.delete(key))
    inflight.set(key, read)
    return await read
  } catch {
    return undefined
  }
}
