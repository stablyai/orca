import { runCoalescedProbe, type CoalescedProbes } from '../git/remotes/coalesced-probe'
import { codeHostReadExecutionScope } from '../source-control/code-host-read-execution-scope'
import { readLocalGitConfigSignature } from '../github/local-git-config-signature'
import {
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'
import { normalizeGitLabHost } from './project-ref-parser'

type ProjectIdentity = { id: number; path: string }
type CachedIdentity = { value: ProjectIdentity; expiresAt: number; configSignature?: string }
const identities = new Map<string, CachedIdentity>()
const pending: CoalescedProbes<ProjectIdentity> = new Map()

function identityKey(
  repoPath: string,
  project: ProjectRef,
  connectionId: string | null | undefined,
  options: LocalGitExecOptions
): string {
  return [
    normalizeGitLabHost(project.host),
    project.path,
    connectionId ?? '',
    codeHostReadExecutionScope(glabRepoExecOptions(repoPath, connectionId, options))
  ].join('\0')
}

export function forgetReviewProjectIdentity(
  repoPath: string,
  project: ProjectRef,
  connectionId: string | null | undefined,
  options: LocalGitExecOptions
): void {
  const key = identityKey(repoPath, project, connectionId, options)
  identities.delete(key)
  pending.delete(key)
}

export function resetReviewProjectIdentitiesForTest(): void {
  identities.clear()
  pending.clear()
}

export async function readReviewProjectIdentity(
  repoPath: string,
  project: ProjectRef,
  connectionId: string | null | undefined,
  options: LocalGitExecOptions,
  force = false
): Promise<ProjectIdentity> {
  const key = identityKey(repoPath, project, connectionId, options)
  const signature = await readLocalGitConfigSignature({ repoPath, connectionId, ...options })
  const cached = identities.get(key)
  if (!force && cached && cached.expiresAt > Date.now() && cached.configSignature === signature) {
    return cached.value
  }
  return runCoalescedProbe(
    pending,
    key,
    async (ownsKey) => {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(project, connectionId),
          `projects/${encodedProject(project.path)}`
        ],
        glabRepoExecOptions(repoPath, connectionId, options)
      )
      const data: unknown = JSON.parse(stdout)
      if (
        !data ||
        typeof data !== 'object' ||
        !('id' in data) ||
        typeof data.id !== 'number' ||
        !Number.isSafeInteger(data.id) ||
        data.id <= 0 ||
        !('path_with_namespace' in data) ||
        typeof data.path_with_namespace !== 'string' ||
        !data.path_with_namespace
      ) {
        throw new Error('Invalid GitLab source project identity')
      }
      const value = { id: data.id, path: data.path_with_namespace }
      if (ownsKey()) {
        identities.set(key, {
          value,
          configSignature: signature,
          expiresAt: Date.now() + 5 * 60_000
        })
        for (const [entryKey, entry] of identities) {
          if (entry.expiresAt <= Date.now()) {
            identities.delete(entryKey)
          }
        }
        while (identities.size > 512) {
          const oldest = identities.keys().next().value
          if (oldest === undefined) {
            break
          }
          identities.delete(oldest)
        }
      }
      return value
    },
    Infinity,
    { userRefresh: force }
  )
}
