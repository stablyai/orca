import {
  IMAGE_AND_PDF_PREVIEW_MIME_TYPES,
  filePreviewExtension
} from '../../../../shared/file-preview/file-preview-kind'

import {
  type GitDiffReadOptions,
  gitReadOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'

/** Image/PDF diffs preview the stored bytes, so a diff driver must not replace them. */
export function isImageOrPdfPreviewPath(filePath: string): boolean {
  return !!IMAGE_AND_PDF_PREVIEW_MIME_TYPES[filePreviewExtension(filePath)]
}

export type DiffAttributes = { hasTextconv: boolean; storesUtf8: boolean }

const NO_DIFF_ATTRIBUTES: DiffAttributes = { hasTextconv: false, storesUtf8: false }

function hasNamedValue(value: string | undefined): boolean {
  return !!value && value !== 'set' && value !== 'unset' && value !== 'unspecified'
}

export async function readDiffAttributes(
  worktreePath: string,
  filePath: string,
  options: GitDiffReadOptions
): Promise<DiffAttributes> {
  if (isImageOrPdfPreviewPath(filePath)) {
    return NO_DIFF_ATTRIBUTES
  }
  const gitPath = filePath.replace(/\\/g, '/')
  const readOptions = gitReadOptionsForWorktree(worktreePath, options)
  try {
    const attrs = options.encoding === 'gb18030' ? ['diff', 'working-tree-encoding'] : ['diff']
    const { stdout } = await gitExecFileAsync(
      ['check-attr', '-z', ...attrs, '--', gitPath],
      readOptions
    )
    // Each attribute contributes path, name and value in that order.
    const fields = stdout.split('\0')
    const driver = fields[2]
    const storesUtf8 = hasNamedValue(fields[5])
    if (!hasNamedValue(driver)) {
      return { hasTextconv: false, storesUtf8 }
    }
    // Missing textconv config must not hide the file's working-tree-encoding.
    const hasTextconv = await gitExecFileAsync(
      ['config', '--get', `diff.${driver}.textconv`],
      readOptions
    ).then(
      ({ stdout }) => stdout.trim() !== '',
      () => false
    )
    return { hasTextconv, storesUtf8 }
  } catch {
    return NO_DIFF_ATTRIBUTES
  }
}
