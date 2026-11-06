import {
  IMAGE_AND_PDF_PREVIEW_MIME_TYPES,
  filePreviewExtension
} from '../../../shared/file-preview-kind'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'

/** Image/PDF diffs preview the stored bytes, so a diff driver must not replace them. */
export function isImageOrPdfPreviewPath(filePath: string): boolean {
  return !!IMAGE_AND_PDF_PREVIEW_MIME_TYPES[filePreviewExtension(filePath)]
}

/** Whether the path's `diff=<driver>` sets `textconv`; never rejects. */
export async function hasTextconvDriver(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  if (isImageOrPdfPreviewPath(filePath)) {
    return false
  }
  const gitPath = filePath.replace(/\\/g, '/')
  const readOptions = gitReadOptionsForWorktree(worktreePath, options)
  try {
    const { stdout } = await gitExecFileAsync(
      ['check-attr', '-z', 'diff', '--', gitPath],
      readOptions
    )
    // -z output is `<path>\0diff\0<value>\0`; set/unset/unspecified name no driver.
    const driver = stdout.split('\0')[2]
    if (!driver || driver === 'set' || driver === 'unset' || driver === 'unspecified') {
      return false
    }
    // `git config --get` exits 1 when the driver has no textconv.
    const { stdout: textconv } = await gitExecFileAsync(
      ['config', '--get', `diff.${driver}.textconv`],
      readOptions
    )
    return textconv.trim() !== ''
  } catch {
    return false
  }
}
