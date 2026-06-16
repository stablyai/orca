import type { WarpThemeImportSkippedFile } from '../../shared/terminal-custom-themes'
import type { PreviewOperationBudget } from './preview-operation-budget'
import {
  MAX_THEME_FILES,
  scanWarpThemeDirectory,
  type ThemeFileCandidate
} from './theme-file-scanner'

export type ThemeSourceSelection =
  | { canceled: true }
  | {
      canceled: false
      sourceLabel: string
      files: ThemeFileCandidate[]
      skippedFiles: WarpThemeImportSkippedFile[]
      rootReadable?: boolean
      themeFileLimitHit?: boolean
    }

export async function filesFromDirectory(
  directoryPath: string,
  sourceLabelOverride?: string,
  budget?: PreviewOperationBudget,
  themeFileLimit = MAX_THEME_FILES,
  reportThemeFileLimit = true
): Promise<ThemeSourceSelection> {
  const { sourceLabel, rootReadable, files, skippedFiles, themeFileLimitHit } =
    await scanWarpThemeDirectory(directoryPath, budget, { themeFileLimit, reportThemeFileLimit })
  const effectiveSourceLabel = sourceLabelOverride ?? sourceLabel
  return {
    canceled: false,
    sourceLabel: effectiveSourceLabel,
    files: files.map((file) => ({ ...file, sourceLabel: effectiveSourceLabel })),
    skippedFiles: skippedFiles.map((file) =>
      file.label === sourceLabel ? { ...file, label: effectiveSourceLabel } : file
    ),
    rootReadable,
    themeFileLimitHit
  }
}
