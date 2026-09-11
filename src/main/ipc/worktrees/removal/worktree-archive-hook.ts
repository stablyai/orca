import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import { getEffectiveHooksFromConfig } from '../../../effective-hook-config'
import { getEffectiveHooks, parseOrcaYaml } from '../../../hooks'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import { requireSshGitProvider } from '../../../providers/ssh-git-dispatch'
import { joinWorktreeRelativePath } from '../../../runtime/runtime-relative-paths'
import { getSetupRunnerEnvVars } from '../../../setup-hook-env-vars'
import type { ArchiveHookRunResult } from '../../../../shared/worktree/archive-hook-removal-gate'

const WORKTREE_ARCHIVE_HOOK_TIMEOUT_MS = 120_000

export async function getArchiveHooksForRemoval(repo: Repo): Promise<OrcaHooks | null> {
  if (!repo.connectionId) {
    return getEffectiveHooks(repo)
  }

  const fsProvider = getSshFilesystemProvider(repo.connectionId)
  if (!fsProvider) {
    return getEffectiveHooksFromConfig(repo, null)
  }

  try {
    const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
    const yamlHooks = result.isBinary ? null : parseOrcaYaml(result.content)
    return getEffectiveHooksFromConfig(repo, yamlHooks)
  } catch {
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
      WORKTREE_ARCHIVE_HOOK_TIMEOUT_MS,
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
