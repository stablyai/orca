import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  pluginGitConfigArgs,
  pluginGitFetchCommitArgs
} from '../../../shared/plugins/installation/plugin-git-arguments'
import { runBoundedPluginGitDownload, runPluginGit } from '../installation/plugin-git-repository'
import { writePluginFileAtomically } from '../installation/plugin-atomic-file-write'

const SHA1_COMMIT_PATTERN = /^[0-9a-f]{40}$/
const CATALOG_SNAPSHOT_REF = 'refs/orca/snapshot'
const CATALOG_FETCHED_REF = 'refs/orca/fetched'

function catalogGit(repository: string, args: string[]): Promise<string> {
  return runPluginGit(
    [
      ...pluginGitConfigArgs(join(repository, 'no-hooks')),
      '--git-dir',
      join(repository, '.git'),
      ...args
    ],
    repository
  )
}

export async function isReusableCatalogRepository(
  repository: string,
  url: string,
  publishedCommit?: string
): Promise<boolean> {
  if (!(await lstat(join(repository, '.git')).catch(() => null))?.isDirectory()) {
    return false
  }
  try {
    await sweepInterruptedCatalogDownload(join(repository, '.git'))
    await catalogGit(repository, ['fsck', '--no-dangling'])
    if (publishedCommit) {
      await catalogGit(repository, ['cat-file', '-e', `${publishedCommit}^{commit}`])
    }
    return (
      (await catalogGit(repository, ['config', '--local', '--get', 'remote.origin.url'])) === url
    )
  } catch {
    return false
  }
}

export async function readRetainedPluginGitCommit<T>(
  input: {
    url: string
    ref: string
    repository: string
    maxDownloadBytes: number
    reusable: boolean
  },
  read: (commit: string) => Promise<T>
): Promise<T> {
  if (!isAllowedPluginGitUrl(input.url)) {
    throw new Error('plugin Git URL must use HTTPS or SSH')
  }
  const { repository } = input
  const gitDir = join(repository, '.git')
  const config = pluginGitConfigArgs(join(repository, 'no-hooks'))
  const ref = input.ref.trim()
  const exactCommit = SHA1_COMMIT_PATTERN.test(ref)
  if (PLUGIN_COMMIT_PATTERN.test(ref) && !exactCommit) {
    throw new Error('SHA-256 plugin repositories are not supported')
  }
  if (!input.reusable) {
    await rm(repository, { recursive: true, force: true })
  }
  let download: Awaited<ReturnType<typeof trackCatalogDownload>> | undefined
  try {
    if (!input.reusable) {
      await mkdir(repository, { recursive: true })
      await runPluginGit([...config, 'init', '--quiet', '--template='], repository)
      await catalogGit(repository, ['remote', 'add', 'origin', input.url])
      await catalogGit(repository, ['config', '--unset-all', 'remote.origin.fetch'])
    }
    download = await trackCatalogDownload(gitDir)
    const remoteRef = exactCommit ? ref : await resolveCatalogRemoteRef(repository, ref)
    await runBoundedPluginGitDownload(
      [...config, '--git-dir', gitDir, ...pluginGitFetchCommitArgs(remoteRef)],
      repository,
      repository,
      input.maxDownloadBytes,
      download.bytes
    )
    const commit = await catalogGit(repository, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    if (!SHA1_COMMIT_PATTERN.test(commit) || (exactCommit && commit !== ref)) {
      throw new Error('Git resolved an invalid catalog commit identity')
    }
    await catalogGit(repository, ['update-ref', CATALOG_FETCHED_REF, commit])
    return await read(commit)
  } catch (error) {
    if (input.reusable && download) {
      await catalogGit(repository, ['update-ref', '-d', CATALOG_FETCHED_REF])
      await download.rollback()
    } else if (!input.reusable) {
      await rm(repository, { recursive: true, force: true })
    }
    throw error
  }
}

async function resolveCatalogRemoteRef(repository: string, ref: string): Promise<string> {
  if (!ref || ref === 'HEAD') {
    return 'HEAD'
  }
  const branch = `refs/heads/${ref}`
  const tag = `refs/tags/${ref}`
  await catalogGit(repository, ['check-ref-format', branch])
  const refs = await catalogGit(repository, ['ls-remote', '--refs', 'origin', branch, tag])
  const names = new Set(refs.split('\n').map((line) => line.split('\t')[1]))
  if (names.has(branch)) {
    return branch
  }
  if (names.has(tag)) {
    return tag
  }
  throw new Error('catalog ref was not found on the remote')
}

async function listCatalogObjectFiles(gitDir: string): Promise<Set<string>> {
  const objects = join(gitDir, 'objects')
  const files = new Set<string>()
  for (const entry of await readdir(objects, { withFileTypes: true })) {
    const path = join(objects, entry.name)
    if (entry.isDirectory()) {
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (!child.isDirectory()) {
          files.add(join(path, child.name))
        }
      }
    } else {
      files.add(path)
    }
  }
  return files
}

async function sweepInterruptedCatalogDownload(gitDir: string): Promise<void> {
  const locks = [
    'shallow.lock',
    'FETCH_HEAD.lock',
    'HEAD.lock',
    'packed-refs.lock',
    `${CATALOG_SNAPSHOT_REF}.lock`,
    `${CATALOG_FETCHED_REF}.lock`
  ]
  const files = [...(await listCatalogObjectFiles(gitDir))].filter((path) =>
    basename(path).startsWith('tmp_')
  )
  await Promise.all([
    ...files.map((path) => rm(path, { force: true })),
    ...locks.map((name) => rm(join(gitDir, name), { force: true }))
  ])
}

async function trackCatalogDownload(gitDir: string) {
  const baseline = await listCatalogObjectFiles(gitDir)
  const newFiles = async () =>
    [...(await listCatalogObjectFiles(gitDir))].filter((path) => !baseline.has(path))
  const state = await Promise.all(
    ['shallow', 'FETCH_HEAD'].map(async (name) => {
      const path = join(gitDir, name)
      const previous = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error
        }
        return null
      })
      return { path, previous }
    })
  )
  return {
    bytes: async () => {
      const sizes = await Promise.all(
        (await newFiles()).map((path) =>
          lstat(path).then(
            (stat) => stat.size,
            () => 0
          )
        )
      )
      return sizes.reduce((total, size) => total + size, 0)
    },
    rollback: async () => {
      await Promise.all(
        state.map(({ path, previous }) =>
          previous === null ? rm(path, { force: true }) : writePluginFileAtomically(path, previous)
        )
      )
      await Promise.all(
        ['shallow.lock', 'FETCH_HEAD.lock'].map((name) => rm(join(gitDir, name), { force: true }))
      )
      await Promise.all((await newFiles()).map((path) => rm(path, { force: true })))
    }
  }
}

export async function pinRetainedPluginGitCommit(
  repository: string,
  commit: string,
  withPruneBarrier: (prune: () => Promise<void>) => Promise<void> = (prune) => prune()
): Promise<void> {
  if (!SHA1_COMMIT_PATTERN.test(commit)) {
    throw new Error('invalid catalog commit')
  }
  const refs = (
    await catalogGit(repository, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      CATALOG_SNAPSHOT_REF,
      CATALOG_FETCHED_REF
    ])
  ).split('\n')
  const superseded = refs.some((ref) => ref && !ref.endsWith(` ${commit}`))
  const pinned = refs.includes(`${CATALOG_SNAPSHOT_REF} ${commit}`)
  if (!pinned || superseded) {
    await catalogGit(repository, ['update-ref', CATALOG_SNAPSHOT_REF, commit])
    await catalogGit(repository, ['update-ref', '--no-deref', 'HEAD', commit])
  }
  if (refs.some((ref) => ref.startsWith(`${CATALOG_FETCHED_REF} `))) {
    await catalogGit(repository, ['update-ref', '-d', CATALOG_FETCHED_REF])
  }
  if (superseded) {
    await withPruneBarrier(async () => {
      await catalogGit(repository, ['reflog', 'expire', '--expire=now', '--all'])
      await catalogGit(repository, ['-c', 'pack.threads=2', 'gc', '--prune=now'])
    })
  }
}
