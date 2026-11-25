import { posix, win32 } from 'node:path'
import { normalizeGitHubPRMergeMethodSettings } from '../../../../shared/github/pull-requests/merge/pull-request-merge-methods'
import { mergeCommandEnvironment } from '../../../../shared/shell/launch/command-environment'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { githubHostExecOptions } from '../../repositories/github-repository-host'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { githubRepoIdentityKey } from '../../../../shared/github/repositories/repository-identity-key'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../api/rate-limit'
import { codeHostReadExecutionScope as githubReadExecutionScope } from '../../../source-control/code-host-read-execution-scope'
import { runCoalescedProbe } from '../../../git/remotes/coalesced-probe'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { extractExecError } from '../../../git/command-runner/process-capture/exec-error'
import { extractGraphqlErrors } from '../../project-view/project-error-classification'
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
  const query = (withRuleMergeMethods: boolean): string =>
    branchName
      ? `query($owner: String!, $repo: String!, $branch: String!, $qualified: String!) {
    repository(owner: $owner, name: $repo) {
      viewerDefaultMergeMethod
      mergeCommitAllowed
      rebaseMergeAllowed
      squashMergeAllowed
      autoMergeAllowed
      mergeQueue(branch: $branch) { id }
      ref(qualifiedName: $qualified) {
        rules(first: 50) { nodes { type${withRuleMergeMethods ? ' parameters { ... on PullRequestParameters { allowedMergeMethods } }' : ''} } }
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
  const runQuery = async (withRuleMergeMethods: boolean): Promise<string> => {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query(withRuleMergeMethods)}`,
      '-f',
      `owner=${ownerRepo.owner}`,
      '-f',
      `repo=${ownerRepo.repo}`
    ]
    if (branchName) {
      args.push('-f', `branch=${branchName}`)
      args.push('-f', `qualified=refs/heads/${branchName}`)
    }
    return (await ghExecFileAsync(args, ghOptions)).stdout
  }
  try {
    let stdout: string
    try {
      stdout = await runQuery(true)
    } catch (error) {
      if (!lacksRuleMergeMethodsSchema(error)) {
        throw error
      }
      stdout = await runQuery(false)
    }
    const parsed: {
      data?: {
        repository?: {
          viewerDefaultMergeMethod?: unknown
          mergeCommitAllowed?: unknown
          rebaseMergeAllowed?: unknown
          squashMergeAllowed?: unknown
          autoMergeAllowed?: unknown
          mergeQueue?: { id?: unknown } | null
          ref?: {
            rules?: {
              nodes?:
                | ({
                    type?: unknown
                    parameters?: { allowedMergeMethods?: unknown } | null
                  } | null)[]
                | null
            } | null
          } | null
        } | null
      }
    } = JSON.parse(stdout)
    const repository = parsed.data?.repository
    // GitHub enforces every PULL_REQUEST rule on the branch, so a method must pass all of them.
    const ruleMergeMethods = (repository?.ref?.rules?.nodes ?? []).flatMap((rule) =>
      rule?.type === 'PULL_REQUEST' && Array.isArray(rule.parameters?.allowedMergeMethods)
        ? [rule.parameters.allowedMergeMethods]
        : []
    )
    const rulesAllow = (method: 'MERGE' | 'SQUASH' | 'REBASE'): boolean =>
      ruleMergeMethods.every((methods) => methods.includes(method))
    const mergeMethodSettings = repository
      ? normalizeGitHubPRMergeMethodSettings({
          defaultMethod: repository.viewerDefaultMergeMethod,
          mergeCommitAllowed: repository.mergeCommitAllowed === true && rulesAllow('MERGE'),
          rebaseMergeAllowed: repository.rebaseMergeAllowed === true && rulesAllow('REBASE'),
          squashMergeAllowed: repository.squashMergeAllowed === true && rulesAllow('SQUASH')
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

// Older GHES schemas lack ruleset merge methods; losing them must not lose merge-queue detection.
function lacksRuleMergeMethodsSchema(error: unknown): boolean {
  const { stderr, stdout } = extractExecError(error)
  const errors = extractGraphqlErrors(stderr, stdout)
  return (
    errors.length > 0 &&
    errors.every((graphqlError) =>
      /'(?:parameters|allowedMergeMethods)'|\bPullRequestParameters\b/.test(
        graphqlError.message ?? ''
      )
    )
  )
}
