import type { Repo } from '../../../../shared/repository/repo-types'
import type { LocalGitExecOptions } from '../../../git/refs/resolution/repo-default-base-ref'
import { resolveWorktreeIncludePaths } from '../../../git/worktrees/content-paths/worktree-include-file'
import { resolveWorktreeSharedDirectories } from '../../../git/worktrees/content-paths/worktree-shared-directories'
import type { WorktreeCreateTimingRecorder } from '../../../workspaces/creation/worktree-create-timing'
import { formatWorktreeIncludeCopyWarning } from './worktree-include-copy-budget'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from './worktree-symlinks'

const MAX_REPORTED_SKIPS = 5

function collectPathSkips() {
  const examples: string[] = []
  let count = 0
  return {
    add: (path: string, reason: string) => {
      count += 1
      if (examples.length < MAX_REPORTED_SKIPS) {
        examples.push(`${JSON.stringify(path)} (${reason})`)
      }
    },
    message: (configuration: string): string | undefined => {
      if (count === 0) {
        return undefined
      }
      const remaining = count - examples.length
      const omitted = remaining > 0 ? ` and ${remaining} more` : ''
      return `${configuration} skipped ${examples.join(', ')}${omitted}.`
    }
  }
}

export async function materializeWorktreeContentPaths(
  repo: Repo,
  worktreePath: string,
  localWorktreeGitOptions: LocalGitExecOptions,
  timing: Pick<WorktreeCreateTimingRecorder, 'time'>
): Promise<{ includeCopyWarning?: string }> {
  const configuredLinkSkips = collectPathSkips()
  const symlinkPaths = repo.symlinkPaths ?? []
  if (symlinkPaths.length > 0) {
    await timing.time('create_symlinks', () =>
      createWorktreeLinkedPaths(repo.path, worktreePath, symlinkPaths, {
        onFailure: configuredLinkSkips.add
      })
    )
  }

  const sharedSkips = collectPathSkips()
  const includeSkips = collectPathSkips()
  const copyFailures = collectPathSkips()
  const [sharedDirectories, includePaths] = await Promise.all([
    timing.time('resolve_shared_directories', () =>
      resolveWorktreeSharedDirectories(repo.path, localWorktreeGitOptions, sharedSkips.add)
    ),
    timing.time('resolve_worktreeinclude', () =>
      resolveWorktreeIncludePaths(repo.path, localWorktreeGitOptions, includeSkips.add)
    )
  ])

  if (sharedDirectories.length > 0) {
    await timing.time('create_shared_directories', () =>
      createWorktreeSharedPaths(repo.path, worktreePath, sharedDirectories, {
        onFailure: sharedSkips.add
      })
    )
  }
  const skippedCopies =
    includePaths.length > 0
      ? await timing.time('copy_worktreeinclude', () =>
          createWorktreeCopiedPaths(repo.path, worktreePath, includePaths, {
            onFailure: copyFailures.add
          })
        )
      : []
  const copyBudgetWarning = formatWorktreeIncludeCopyWarning(skippedCopies)
  if (copyBudgetWarning) {
    console.warn(`[worktree-include] ${copyBudgetWarning}`)
  }
  const includeCopyWarning = [
    configuredLinkSkips.message('Worktree Shared Paths'),
    sharedSkips.message('worktree.sharedDirectories'),
    includeSkips.message('.worktreeinclude'),
    copyFailures.message('.worktreeinclude copy'),
    copyBudgetWarning
  ]
    .filter(Boolean)
    .join(' ')
  return includeCopyWarning ? { includeCopyWarning } : {}
}
