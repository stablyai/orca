import { posix, win32 } from 'node:path'
import { normalizeGitHubPRMergeMethodSettings } from '../../../../shared/github/pull-request-merge-methods'
import { mergeCommandEnvironment } from '../../../../shared/command-environment'
import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import { runCoalescedProbe } from '../../../git/coalesced-probe'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import type { GhExecOptions } from './../github-exec-scope'
import {
  MERGE_QUEUE_CACHE_TTL_MS,
  MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS,
  repositoryMergeMetadataCache,
  repositoryMergeMetadataReadProbes,
  repositoryMergeMetadataWriters,
  pruneRepositoryMergeMetadataCache,
  cacheRepositoryMergeMetadata,
  type GitHubRepositoryMergeMetadata
} from './repository-merge-metadata-cache'
export async function detectRepositoryMergeMetadata(
  ownerRepo: GitHubApiRepository,
  branchName: string | undefined,
  ghOptions: GhExecOptions,
  executionScope: string | undefined = 'default'
): Promise<GitHubRepositoryMergeMetadata> {
  const options = { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
  const { cwd, signal: _signal, ...cacheOptions } = options
  const wslDistro = options.wslDistro ?? (cwd ? parseWslUncPath(cwd)?.distro : undefined)
  const configPaths = wslDistro || process.platform !== 'win32' ? posix : win32
  const environment = options.env ?? process.env
  const configEnvironment =
    configPaths === win32 ? mergeCommandEnvironment(environment, {}, 'win32') : environment
  const configDir =
    configEnvironment?.GH_CONFIG_DIR ||
    configEnvironment?.XDG_CONFIG_HOME ||
    (configPaths === win32
      ? configEnvironment?.APPDATA || configEnvironment?.USERPROFILE
      : configEnvironment?.HOME)
  const configNeedsCwd =
    !configDir ||
    !configPaths.isAbsolute(configDir) ||
    (configPaths === win32 && configPaths.parse(configDir).root.length === 1)
  const cacheKey = JSON.stringify([
    executionScope,
    githubReadExecutionScope({
      ...cacheOptions,
      wslDistro,
      ...(configNeedsCwd ? { cwd } : {})
    }),
    githubRepoIdentityKey(ownerRepo),
    branchName ?? null
  ])
  pruneRepositoryMergeMetadataCache()
  const cached = repositoryMergeMetadataCache.get(cacheKey)
  if (cached) {
    return cached.value
  }
  // Cold probes keep cwd even when completed settings can span worktrees.
  const readKey = JSON.stringify([cacheKey, githubReadExecutionScope(options)])
  return runCoalescedProbe(
    repositoryMergeMetadataReadProbes(options.signal),
    readKey,
    async (ownsKey) => {
      const writer = repositoryMergeMetadataWriters.get(cacheKey) ?? {
        activeReads: 0,
        nextRead: 0,
        publishedRead: 0
      }
      repositoryMergeMetadataWriters.set(cacheKey, writer)
      const readId = ++writer.nextRead
      writer.activeReads++
      try {
        return await readRepositoryMergeMetadata(
          ownerRepo,
          branchName,
          options,
          (value, ttlMs, authoritative) => {
            if (
              ownsKey() &&
              !options.signal?.aborted &&
              repositoryMergeMetadataWriters.get(cacheKey) === writer &&
              readId >= writer.publishedRead
            ) {
              if (!authoritative && repositoryMergeMetadataCache.has(cacheKey)) {
                return
              }
              if (authoritative) {
                writer.publishedRead = readId
              }
              cacheRepositoryMergeMetadata(cacheKey, value, ttlMs)
            }
          }
        )
      } finally {
        writer.activeReads--
        if (writer.activeReads === 0 && repositoryMergeMetadataWriters.get(cacheKey) === writer) {
          repositoryMergeMetadataWriters.delete(cacheKey)
        }
      }
    }
  )
}

async function readRepositoryMergeMetadata(
  ownerRepo: GitHubApiRepository,
  branchName: string | undefined,
  ghOptions: GhExecOptions,
  publish: (value: GitHubRepositoryMergeMetadata, ttlMs: number, authoritative: boolean) => void
): Promise<GitHubRepositoryMergeMetadata> {
  if (
    ghOptions.signal?.aborted ||
    repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions).blocked
  ) {
    return { mergeQueueRequired: null, autoMergeAllowed: null }
  }
  const query = branchName
    ? `query($owner: String!, $repo: String!, $branch: String!, $qualified: String!) {
    repository(owner: $owner, name: $repo) {
      viewerDefaultMergeMethod
      mergeCommitAllowed
      rebaseMergeAllowed
      squashMergeAllowed
      autoMergeAllowed
      mergeQueue(branch: $branch) { id }
      ref(qualifiedName: $qualified) {
        rules(first: 50) { nodes { type } }
      }
    }
  }`
    : `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      viewerDefaultMergeMethod
      mergeCommitAllowed
      rebaseMergeAllowed
      squashMergeAllowed
      autoMergeAllowed
    }
  }`
  try {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${ownerRepo.owner}`,
      '-f',
      `repo=${ownerRepo.repo}`
    ]
    if (branchName) {
      args.push('-f', `branch=${branchName}`)
      args.push('-f', `qualified=refs/heads/${branchName}`)
    }
    const { stdout } = await ghExecFileAsync(args, ghOptions)
    const parsed = JSON.parse(stdout) as {
      data?: {
        repository?: {
          viewerDefaultMergeMethod?: unknown
          mergeCommitAllowed?: unknown
          rebaseMergeAllowed?: unknown
          squashMergeAllowed?: unknown
          autoMergeAllowed?: unknown
          mergeQueue?: { id?: unknown } | null
          ref?: { rules?: { nodes?: ({ type?: unknown } | null)[] | null } | null } | null
        } | null
      }
    }
    const repository = parsed.data?.repository
    const mergeMethodSettings = repository
      ? normalizeGitHubPRMergeMethodSettings({
          defaultMethod: repository.viewerDefaultMergeMethod,
          mergeCommitAllowed: repository.mergeCommitAllowed,
          rebaseMergeAllowed: repository.rebaseMergeAllowed,
          squashMergeAllowed: repository.squashMergeAllowed
        })
      : undefined
    const value: GitHubRepositoryMergeMetadata = {
      mergeQueueRequired: branchName
        ? Boolean(repository?.mergeQueue) ||
          Boolean(repository?.ref?.rules?.nodes?.some((rule) => rule?.type === 'MERGE_QUEUE'))
        : null,
      autoMergeAllowed:
        typeof repository?.autoMergeAllowed === 'boolean' ? repository.autoMergeAllowed : null,
      ...(mergeMethodSettings ? { mergeMethodSettings } : {})
    }
    // Missing repository data remains unknown and retries on the short TTL.
    publish(
      value,
      repository ? MERGE_QUEUE_CACHE_TTL_MS : MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS,
      Boolean(repository)
    )
    return value
  } catch {
    // Cool down failed probes without treating unknown merge-queue state as false.
    const value: GitHubRepositoryMergeMetadata = {
      mergeQueueRequired: null,
      autoMergeAllowed: null
    }
    publish(value, MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS, false)
    return value
  }
}
