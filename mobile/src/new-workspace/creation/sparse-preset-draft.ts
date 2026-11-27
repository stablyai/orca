import { readSparsePresetDirectories } from '../../../../src/shared/worktree/creation/sparse-preset-draft-rules'
import type { Translate } from '../../i18n/mobile-i18n'

export type SparsePresetDirectoryParseResult = {
  directories: string[]
  error: string | null
}

export function parseSparsePresetDirectories(
  t: Translate,
  value: string
): SparsePresetDirectoryParseResult {
  const { directories, problem } = readSparsePresetDirectories(value)
  return {
    directories,
    error:
      problem === 'directory-required'
        ? t('tasks.sparsePresetDraft.directoryRequired', 'Add at least one directory.')
        : problem === 'repo-relative-required'
          ? t(
              'tasks.sparsePresetDraft.repoRelativeDirectoriesRequired',
              'Use repo-relative directories, not root, absolute paths, or parent segments.'
            )
          : null
  }
}
