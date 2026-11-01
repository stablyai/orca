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

/** The path's `diff=<driver>` when that driver sets `textconv`; never rejects. */
export async function readTextconvDriver(
  worktreePath: string,
  gitPath: string,
  options: GitRuntimeOptions
): Promise<string | undefined> {
  if (isImageOrPdfPreviewPath(gitPath)) {
    return undefined
  }
  const readOptions = gitReadOptionsForWorktree(worktreePath, options)
  try {
    const { stdout } = await gitExecFileAsync(
      ['check-attr', '-z', 'diff', '--', gitPath],
      readOptions
    )
    // -z output is `<path>\0diff\0<value>\0`; set/unset/unspecified name no driver.
    const driver = stdout.split('\0')[2]
    if (!driver || driver === 'set' || driver === 'unset' || driver === 'unspecified') {
      return undefined
    }
    // `git config --get` exits 1 when the driver has no textconv.
    const { stdout: textconv } = await gitExecFileAsync(
      ['config', '--get', `diff.${driver}.textconv`],
      readOptions
    )
    return textconv.trim() ? driver : undefined
  } catch {
    return undefined
  }
}
