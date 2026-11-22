import { lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  pluginGitCloneArgs,
  pluginGitConfigArgs,
  pluginGitFetchCommitArgs
} from '../../../shared/plugins/installation/plugin-git-arguments'
import {
  pluginGitRepositoryBytes,
  runBoundedPluginGitDownload,
  runPluginGit
} from '../installation/plugin-git-repository'

const SHA1_COMMIT_PATTERN = /^[0-9a-f]{40}$/
const CATALOG_SNAPSHOT_REF = 'refs/orca/snapshot'
const CATALOG_FETCHED_REF = 'refs/orca/fetched'

/** Reuses a shallow catalog repository; the published snapshot remains pinned during refresh. */
export async function readRetainedPluginGitCommit<T>(
  input: {
    url: string
    ref: string
    directory: string
    maxDownloadBytes: number
    publishedCommit?: string
  },
  read: (repository: string, commit: string) => Promise<T>
): Promise<{ commit: string; value: T }> {
  if (!isAllowedPluginGitUrl(input.url)) {
    throw new Error('plugin Git URL must use HTTPS or SSH')
  }
  if (input.publishedCommit && !SHA1_COMMIT_PATTERN.test(input.publishedCommit)) {
    throw new Error('invalid published catalog commit')
  }
  const repository = join(input.directory, 'repository')
  const hooks = join(input.directory, 'no-hooks')
  const config = pluginGitConfigArgs(hooks)
  let reusable = false
  const exists = await lstat(join(repository, '.git')).then(
    (entry) => entry.isDirectory(),
    () => false
  )
  if (exists) {
    try {
      await runPluginGit([...config, 'fsck', '--no-dangling'], repository)
      reusable =
        (await runPluginGit(
          [...config, 'config', '--local', '--get', 'remote.origin.url'],
          repository
        )) === input.url
      if (input.publishedCommit) {
        await runPluginGit(
          [...config, 'cat-file', '-e', `${input.publishedCommit}^{commit}`],
          repository
        )
      }
    } catch {
      reusable = false
    }
  }
  await mkdir(input.directory, { recursive: true })
  const ref = input.ref.trim()
  if (PLUGIN_COMMIT_PATTERN.test(ref) && !SHA1_COMMIT_PATTERN.test(ref)) {
    throw new Error('SHA-256 plugin repositories are not supported')
  }
  const exactCommit = SHA1_COMMIT_PATTERN.test(ref)
  if (!exactCommit) {
    await runPluginGit([...config, 'check-ref-format', '--branch', ref], input.directory)
  }
  if (!reusable) {
    await rm(input.directory, { recursive: true, force: true })
    await mkdir(hooks, { recursive: true })
    if (exactCommit) {
      await mkdir(repository)
      await runPluginGit([...config, 'init', '--quiet', '--template='], repository)
      await runPluginGit([...config, 'remote', 'add', 'origin', input.url], repository)
    } else {
      await runBoundedPluginGitDownload(
        [...config, ...pluginGitCloneArgs(input.url, ref, repository)],
        input.directory,
        repository,
        input.maxDownloadBytes
      )
    }
    await runPluginGit(
      [...config, 'config', '--unset-all', 'remote.origin.fetch'],
      repository
    ).catch(() => undefined)
  }
  if (reusable && input.publishedCommit) {
    await pinRetainedPluginGitCommit(input.directory, input.publishedCommit)
  }
  if (reusable || exactCommit) {
    // The published pack remains available while the candidate is downloading.
    const existingBytes = reusable ? await pluginGitRepositoryBytes(repository) : 0
    await runBoundedPluginGitDownload(
      [...config, '--git-dir', join(repository, '.git'), ...pluginGitFetchCommitArgs(ref)],
      repository,
      repository,
      input.maxDownloadBytes,
      existingBytes
    )
  }
  const commit = await runPluginGit(
    ['rev-parse', '--verify', `${reusable || exactCommit ? 'FETCH_HEAD' : 'HEAD'}^{commit}`],
    repository
  )
  if (!SHA1_COMMIT_PATTERN.test(commit)) {
    throw new Error('Git resolved an invalid catalog commit identity')
  }
  if (SHA1_COMMIT_PATTERN.test(ref) && commit !== ref) {
    throw new Error('Git fetched a different commit than requested')
  }
  await runPluginGit([...config, 'update-ref', CATALOG_FETCHED_REF, commit], repository)
  if (!reusable) {
    await runPluginGit([...config, 'update-ref', '--no-deref', 'HEAD', commit], repository)
    const refs = await runPluginGit(
      ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/', 'refs/tags/'],
      repository
    )
    for (const name of refs.split('\n').filter(Boolean)) {
      await runPluginGit([...config, 'update-ref', '-d', name], repository)
    }
  }
  return { commit, value: await read(repository, commit) }
}

export async function pinRetainedPluginGitCommit(directory: string, commit: string): Promise<void> {
  if (!SHA1_COMMIT_PATTERN.test(commit)) {
    throw new Error('invalid catalog commit')
  }
  const repository = join(directory, 'repository')
  const config = pluginGitConfigArgs(join(directory, 'no-hooks'))
  const refs = await runPluginGit(
    [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      CATALOG_SNAPSHOT_REF,
      CATALOG_FETCHED_REF
    ],
    repository
  )
  const superseded = refs.split('\n').some((ref) => ref && !ref.endsWith(` ${commit}`))
  const pinned = refs.split('\n').includes(`${CATALOG_SNAPSHOT_REF} ${commit}`)
  if (!pinned || superseded) {
    await runPluginGit([...config, 'update-ref', CATALOG_SNAPSHOT_REF, commit], repository)
    await runPluginGit([...config, 'update-ref', '--no-deref', 'HEAD', commit], repository)
  }
  if (refs.includes(`${CATALOG_FETCHED_REF} `)) {
    await runPluginGit([...config, 'update-ref', '-d', CATALOG_FETCHED_REF], repository)
  }
  if (superseded) {
    await runPluginGit([...config, 'reflog', 'expire', '--expire=now', '--all'], repository)
    await runPluginGit([...config, '-c', 'pack.threads=2', 'gc', '--prune=now'], repository)
  }
}
