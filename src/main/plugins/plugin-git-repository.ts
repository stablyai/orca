import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN
} from '../../shared/plugins/plugin-install-lockfile'
import {
  pluginGitCloneArgs,
  pluginGitConfigArgs,
  pluginGitFetchCommitArgs
} from '../../shared/plugins/plugin-git-arguments'
import { gitExecFileAsync } from '../git/runner'
import { MAX_PLUGIN_TOTAL_BYTES } from './plugin-content-hash'
import { materializePluginGitTree } from './plugin-git-tree'

const PLUGIN_GIT_TIMEOUT_MS = 120_000
// Why headroom over the tree cap: a depth-1 pack of incompressible files carries per-object overhead.
export const PLUGIN_GIT_DOWNLOAD_MAX_BYTES = MAX_PLUGIN_TOTAL_BYTES + 16 * 1024 * 1024
const DOWNLOAD_POLL_MS = 200
const SHA1_COMMIT_PATTERN = /^[0-9a-f]{40}$/

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

/** Runs system Git with argv-only invocation so credential helpers and SSH
 * remotes work without exposing an executable remote-helper surface. */
export async function runPluginGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, {
    cwd,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: pluginGitAllowedProtocols() },
    timeout: PLUGIN_GIT_TIMEOUT_MS,
    // Why: abort must stop remote-https and index-pack too, and settle only once they exit.
    ...(signal ? { signal, terminationBarrier: true } : {})
  })
  return stdout.trim()
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
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-git-'))
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

/** Writes one ref's exact files into an empty destination and returns its commit. */
export async function checkoutPluginGitSource(input: {
  url: string
  ref: string
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
      materializePluginGitTree({ repository, commit: resolved, destination: input.destination })
  )
  return commit
}
