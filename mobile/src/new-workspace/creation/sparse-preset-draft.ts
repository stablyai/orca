import { readSparsePresetDirectories } from '../../../../src/shared/worktree/creation/sparse-preset-draft-rules'
import { translate } from '../../i18n/mobile-i18n'

export type SparsePresetDirectoryParseResult = {
  directories: string[]
  error: string | null
}

export function parseSparsePresetDirectories(value: string): SparsePresetDirectoryParseResult {
  const { directories, problem } = readSparsePresetDirectories(value)
  return {
    directories,
    error:
      problem === 'directory-required'
        ? translate('tasks.sparsePresetDraft.directoryRequired', 'Add at least one directory.')
        : problem === 'repo-relative-required'
          ? translate(
              'tasks.sparsePresetDraft.repoRelativeDirectoriesRequired',
              'Use repo-relative directories, not root, absolute paths, or parent segments.'
            )
          : null
  }
}
