import type { Repo } from '../../shared/repo-types'
import {
  copyExcludedFolderList,
  type PerforceSettings
} from '../../shared/perforce/perforce-settings'
import { requireCreateOptions } from '../../shared/perforce/workspace-copy/workspace-copy-arguments'
import type { WorkspaceCopyBackend } from '../../shared/perforce/workspace-copy/workspace-copy-backend'
import { uniqueCopyName } from '../../shared/perforce/workspace-copy/workspace-copy-name-rules'
import { toCopyName } from '../../shared/perforce/workspace-copy/workspace-copy-names'
import type { PerforceCopyCreateSummary } from '../../shared/perforce/workspace-copy/workspace-copy-types'
import { getPerforceCopyWorktreeId } from '../../shared/worktree/perforce-copy-worktree'
import { copyWorktreePath } from './perforce-copy-worktrees'

const GB = 1024 ** 3

export type PerforceCopyCreation = {
  worktreeId: string
  summary: PerforceCopyCreateSummary
}

/**
 * Makes the Perforce copy behind a new workspace of Perforce project `repo`: named after the
 * workspace, on the stream the user chose, with Settings > Perforce's copy options. Records nothing;
 * the caller stores the workspace the way its transport does.
 */
export async function createPerforceCopyForWorkspace(input: {
  backend: WorkspaceCopyBackend
  repo: Repo
  sourceDir: string
  workspaceName: string
  stream: unknown
  settings: PerforceSettings
  onProgress?: (detail: string) => void
}): Promise<PerforceCopyCreation> {
  const { backend, repo, sourceDir, settings, onProgress } = input
  onProgress?.('Checking the workspace, the drive and Perforce…')
  const taken = (await backend.list(sourceDir)).copies.map((copy) => copy.name)
  const options = requireCreateOptions({
    name: uniqueCopyName(toCopyName(input.workspaceName), taken),
    stream: input.stream,
    skipPackageCache: settings.copySkipPackageCache,
    extraExcludedFolders: copyExcludedFolderList(settings),
    minFreeBytes: settings.copyMinFreeSpaceGb * GB
  })
  const copy = await backend.create(sourceDir, options, (step) => onProgress?.(step.message))
  return {
    worktreeId: getPerforceCopyWorktreeId(
      repo,
      copyWorktreePath(repo, copy.source.root, copy.copyRoot)
    ),
    summary: {
      name: copy.name,
      copyRoot: copy.copyRoot,
      stream: copy.stream,
      streamChoice: copy.streamChoice,
      space: copy.space,
      warnings: copy.warnings,
      unityVersionControlBinding: copy.unityVersionControlBinding
    }
  }
}
