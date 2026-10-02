import type { FormatOnSaveResult } from '../../shared/format-on-save-command'

export type EditorApi = {
  formatOnSave: (args: {
    repoId: string
    worktreePath: string
    filePath: string
  }) => Promise<FormatOnSaveResult>
}
