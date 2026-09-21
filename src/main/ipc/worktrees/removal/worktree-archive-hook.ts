import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import { getEffectiveHooksFromConfig } from '../../../effective-hook-config'
import { getEffectiveHooks, parseOrcaYaml } from '../../../hooks'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import { requireSshGitProvider } from '../../../providers/ssh-git-dispatch'
import { joinWorktreeRelativePath } from '../../../runtime/runtime-relative-paths'
import { getSetupRunnerEnvVars } from '../../../setup-hook-env-vars'
import {
  ARCHIVE_HOOK_TIMEOUT_MS,
  type ArchiveHookRunResult
} from '../../../../shared/worktree/archive-hook-removal-gate'

/**
 * Resolve the archive hook against the host that owns the worktree.
 *
 * A failed read is answered as "no hook", which is a known limitation rather than a judgement: a
 * missing `orca.yaml` is indistinguishable from an unreachable one here, because the relay rewrites
 * a non-numeric error code to `-32000` (`src/relay/dispatcher-rpc-routing.ts`), so nothing survives
 * to tell ENOENT from a transport failure. Reporting it as unreadable fired on every SSH repo that
 * simply has no orca.yaml; blocking on it would refuse those deletes outright. Distinguishing the
 * two needs a provider contract that reports absence as a successful outcome — tracked in #20196.
 *
 * @param connectionId Overrides `repo.connectionId`, which answers null for a row that names its
 *   owner only as `executionHostId: 'ssh:<target>'`. Callers holding a resolved removal route must
 *   pass it, or an SSH-hosted repo is read on the local disk and its archive hook goes unseen.
 */
export async function getArchiveHooksForRemoval(
  repo: Repo,
  connectionId?: string
): Promise<OrcaHooks | null> {
  const owner = connectionId ?? repo.connectionId
  if (!owner) {
    return getEffectiveHooks(repo)
  }

  const fsProvider = getSshFilesystemProvider(owner)
  if (!fsProvider) {
    // Fail-open, and the one case here we can name confidently: no provider means the host's
    // orca.yaml was never even looked at, so "no archive hook" is an assumption. Logged rather
    // than surfaced, because the removal that follows fails on its own missing provider anyway.
    console.warn(
      `[hooks] no SSH filesystem provider for ${owner}; treating ${repo.path} as having no archive hook`
    )
    return getEffectiveHooksFromConfig(repo, null)
  }

  try {
    const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
    const yamlHooks = result.isBinary ? null : parseOrcaYaml(result.content)
    return getEffectiveHooksFromConfig(repo, yamlHooks)
  } catch (error) {
    // Indistinguishable from "there is no orca.yaml": the relay rewrites a non-numeric error code
    // to -32000 (src/relay/dispatcher-rpc-routing.ts), so nothing survives to tell ENOENT from a
    // transport failure. Logged so an operator can see it; not surfaced, because reporting it as
    // unreadable fired on every SSH repo that simply has none. Distinguishing them needs a provider
    // contract that returns absence as a successful outcome — #20196.
    console.warn(
      `[hooks] could not read orca.yaml for ${repo.path} on ${owner}; treating it as having no archive hook:`,
      error instanceof Error ? error.message : String(error)
    )
    return getEffectiveHooksFromConfig(repo, null)
  }
}

export async function runRemoteArchiveHook(
  repo: Repo,
  worktreePath: string,
  script: string
): Promise<ArchiveHookRunResult> {
  if (!repo.connectionId) {
    return { success: true, output: '' }
  }

  const provider = requireSshGitProvider(repo.connectionId)
  const env = getSetupRunnerEnvVars(repo, worktreePath)
  const isWindowsRemote = isWindowsAbsolutePathLike(worktreePath)
  const result = await provider
    .execNonInteractive(
      isWindowsRemote ? 'cmd.exe' : '/bin/bash',
      isWindowsRemote ? ['/d', '/s', '/c', script] : ['-lc', script],
      worktreePath,
      ARCHIVE_HOOK_TIMEOUT_MS,
      undefined,
      env
    )
    .catch((error) => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error)
    }))
  const output = [
    result.stdout,
    result.stderr,
    result.spawnError,
    result.timedOut ? 'archive hook timed out' : null,
    typeof result.exitCode === 'number' && result.exitCode !== 0
      ? `archive hook exited ${result.exitCode}`
      : null
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .trim()

  // Why (#19334): a spawn error or timeout means the host never reported an exit for this run, so
  // the code is withheld and the gate classifies the failure `unverifiable` rather than `exited`.
  const observedExit =
    !result.spawnError && !result.timedOut && typeof result.exitCode === 'number'
      ? result.exitCode
      : undefined
  return {
    success: observedExit === 0,
    output,
    ...(observedExit !== undefined ? { exitCode: observedExit } : {})
  }
}
