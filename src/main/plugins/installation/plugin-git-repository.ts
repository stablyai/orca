import { findGitSubcommandIndex } from '../../../shared/git/commands/git-command-classification'
import { performance } from 'node:perf_hooks'
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../../git/command-runner/git-exec-file'
import { MAX_PLUGIN_TOTAL_BYTES } from '../artifacts/plugin-content-hash'
import { materializePluginGitTree, type PluginGitBytesRunner } from './plugin-git-tree'
import { PLUGIN_GIT_CLONE_TEMP_PREFIX } from './plugin-git-temp-sweep'

const PLUGIN_GIT_TIMEOUT_MS = 120_000
// Why headroom over the tree cap: a depth-1 pack of incompressible files carries per-object overhead.
export const PLUGIN_GIT_DOWNLOAD_MAX_BYTES = MAX_PLUGIN_TOTAL_BYTES + 16 * 1024 * 1024
const DOWNLOAD_POLL_MS = 200
const SHA1_COMMIT_PATTERN = /^[0-9a-f]{40}$/

const mainProcessGitBytes: PluginGitBytesRunner = async (args, options) =>
  (
    await gitExecFileAsyncBuffer(args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBytes,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {})
    })
  ).stdout

/** Overrides any user `protocol.<helper>.allow`, so an insteadOf rewrite cannot reach a custom
 *  git-remote-* helper; a stricter inherited allowlist still narrows it. */
export function pluginGitAllowedProtocols(inherited = process.env.GIT_ALLOW_PROTOCOL): string {
  const allowed = ['https', 'ssh']
  if (inherited === undefined) {
    return allowed.join(':')
  }
  const narrowed = new Set(inherited.split(':'))
  // An empty list allows no transport, matching Git's reading of an empty variable.
  return allowed.filter((name) => narrowed.has(name)).join(':')
}

const pluginGitShutdown = new AbortController()

/** Stops every running and later plugin Git call so no clone outlives the app. */
export function abortPluginGitForShutdown(): void {
  pluginGitShutdown.abort()
}

/** Runs system Git with argv-only invocation so credential helpers and SSH
 * remotes work without exposing an executable remote-helper surface. */
export async function runPluginGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  const name = args[findGitSubcommandIndex(args)] ?? ''
  const command = /^[a-z]+(?:-[a-z]+)*$/.test(name) ? name : 'command'
  const started = performance.now()
  console.debug('[plugins:git] start', command)
  try {
    const { stdout } = await gitExecFileAsync(args, {
      cwd,
      env: { ...process.env, GIT_ALLOW_PROTOCOL: pluginGitAllowedProtocols() },
      timeout: PLUGIN_GIT_TIMEOUT_MS,
      signal: signal ? AbortSignal.any([signal, pluginGitShutdown.signal]) : pluginGitShutdown.signal,
      // Why: abort must stop remote-https and index-pack too, and settle only once they exit.
      terminationBarrier: true
    })
    return stdout.trim()
  } finally {
    console.debug('[plugins:git] complete', command, `${Math.round(performance.now() - started)}ms`)
  }
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name)
    total += entry.isDirectory()
      ? await directoryBytes(child)
      : await lstat(child).then(
          (stat) => stat.size,
          () => 0
        )
  }
  return total
}

/** Git has no client-side fetch size limit, so poll the pack landing on disk and stop it.
 *  The cap is approximate: a fast link can overshoot by one poll interval of transfer. */
async function runBoundedDownload(
  args: string[],
  cwd: string,
  repository: string,
  maxBytes: number
): Promise<void> {
  const controller = new AbortController()
  let exceeded = false
  let measuring = false
  const timer = setInterval(() => {
    if (measuring) {
      return
    }
    measuring = true
    void directoryBytes(repository)
      .then((bytes) => {
        if (bytes > maxBytes && !controller.signal.aborted) {
          exceeded = true
          controller.abort()
        }
      })
      .finally(() => {
        measuring = false
      })
  }, DOWNLOAD_POLL_MS)
  try {
    await runPluginGit(args, cwd, controller.signal)
  } catch (error) {
    if (exceeded) {
      throw new Error('plugin repository exceeds the download size limit')
    }
    throw error
  } finally {
    clearInterval(timer)
  }
  if ((await directoryBytes(repository)) > maxBytes) {
    throw new Error('plugin repository exceeds the download size limit')
  }
}

/** Downloads one ref without a checkout, hands the exact commit to `read`, then deletes it. */
export async function readPluginGitCommit<T>(
  input: { url: string; ref: string; workingDirectory: string; maxDownloadBytes: number },
  read: (repository: string, commit: string) => Promise<T>
): Promise<{ commit: string; value: T }> {
  if (!isAllowedPluginGitUrl(input.url)) {
    throw new Error('plugin Git URL must use HTTPS or SSH')
  }
  const ref = input.ref.trim()
  const exactCommit = PLUGIN_COMMIT_PATTERN.test(ref)
  if (exactCommit && !SHA1_COMMIT_PATTERN.test(ref)) {
    throw new Error('SHA-256 plugin repositories are not supported')
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), PLUGIN_GIT_CLONE_TEMP_PREFIX))
  const repository = join(temporaryRoot, 'repository')
  const hooks = join(temporaryRoot, 'no-hooks')
  const config = pluginGitConfigArgs(hooks)
  try {
    await mkdir(hooks)
    await mkdir(repository)
    if (exactCommit) {
      await runPluginGit([...config, 'init', '--quiet', '--template=', repository], temporaryRoot)
      await runPluginGit([...config, 'remote', 'add', 'origin', input.url], repository)
      await runBoundedDownload(
        [...config, ...pluginGitFetchCommitArgs(ref)],
        repository,
        repository,
        input.maxDownloadBytes
      )
    } else {
      const args = [...config, ...pluginGitCloneArgs(input.url, ref, repository)]
      await runBoundedDownload(args, input.workingDirectory, repository, input.maxDownloadBytes)
    }
    const commit = await runPluginGit(
      ['rev-parse', '--verify', `${exactCommit ? 'FETCH_HEAD' : 'HEAD'}^{commit}`],
      repository
    )
    if (!SHA1_COMMIT_PATTERN.test(commit)) {
      throw new Error(
        PLUGIN_COMMIT_PATTERN.test(commit)
          ? 'SHA-256 plugin repositories are not supported'
          : 'Git resolved an invalid commit identity'
      )
    }
    if (exactCommit && commit !== ref) {
      throw new Error('Git fetched a different commit than requested')
    }
    return { commit, value: await read(repository, commit) }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

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
  const exists = await lstat(repository).then(
    (entry) => entry.isDirectory(),
    () => false
  )
  if (exists) {
    try {
      await runPluginGit([...config, 'fsck', '--no-dangling'], repository)
      reusable =
        (await runPluginGit([...config, 'remote', 'get-url', 'origin'], repository)) === input.url
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
  if (!reusable) {
    await rm(input.directory, { recursive: true, force: true })
    await mkdir(hooks, { recursive: true })
    await mkdir(repository)
    await runPluginGit([...config, 'init', '--bare', '--quiet', '--template='], repository)
    await runPluginGit([...config, 'remote', 'add', 'origin', input.url], repository)
    await runPluginGit([...config, 'config', '--unset-all', 'remote.origin.fetch'], repository)
  }
  if (reusable && input.publishedCommit) {
    await runPluginGit(
      [...config, 'update-ref', 'refs/orca/snapshot', input.publishedCommit],
      repository
    )
    const pending = await runPluginGit(
      ['rev-parse', '--verify', '--quiet', 'refs/orca/fetched^{commit}'],
      repository
    ).catch(() => null)
    await runPluginGit([...config, 'update-ref', '-d', 'refs/orca/fetched'], repository)
    if (pending && pending !== input.publishedCommit) {
      await runPluginGit([...config, 'reflog', 'expire', '--expire=now', '--all'], repository)
      await runPluginGit([...config, '-c', 'pack.threads=2', 'gc', '--prune=now'], repository)
    }
  }
  const ref = input.ref.trim()
  if (PLUGIN_COMMIT_PATTERN.test(ref) && !SHA1_COMMIT_PATTERN.test(ref)) {
    throw new Error('SHA-256 plugin repositories are not supported')
  }
  if (!SHA1_COMMIT_PATTERN.test(ref)) {
    await runPluginGit([...config, 'check-ref-format', '--branch', ref], repository)
  }
  await runBoundedDownload(
    [...config, '--git-dir', repository, ...pluginGitFetchCommitArgs(ref)],
    repository,
    repository,
    input.maxDownloadBytes
  )
  const commit = await runPluginGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], repository)
  if (!SHA1_COMMIT_PATTERN.test(commit)) {
    throw new Error('Git resolved an invalid catalog commit identity')
  }
  if (SHA1_COMMIT_PATTERN.test(ref) && commit !== ref) {
    throw new Error('Git fetched a different commit than requested')
  }
  await runPluginGit([...config, 'update-ref', 'refs/orca/fetched', commit], repository)
  return { commit, value: await read(repository, commit) }
}

/** Writes one ref's exact files into an empty destination and returns its commit. */
export async function checkoutPluginGitSource(input: {
  url: string
  ref: string
  /** Plugin directory inside the repository; absent means the repository root. */
  path?: string
  destination: string
  workingDirectory: string
  maxDownloadBytes?: number
}): Promise<string> {
  await mkdir(input.destination, { recursive: true })
  if ((await readdir(input.destination)).length > 0) {
    throw new Error('plugin Git destination must be empty')
  }
  const { commit } = await readPluginGitCommit(
    { ...input, maxDownloadBytes: input.maxDownloadBytes ?? PLUGIN_GIT_DOWNLOAD_MAX_BYTES },
    (repository, resolved) =>
      materializePluginGitTree({
        repository,
        commit: resolved,
        destination: input.destination,
        ...(input.path ? { path: input.path } : {}),
        git: mainProcessGitBytes
      })
  )
  return commit
}
