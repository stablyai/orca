import { createHash } from 'node:crypto'
import path from 'node:path'
import { BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from 'electron'
import type { WarpThemeImportSkippedFile } from '../../shared/terminal-custom-themes'
import {
  compareThemeFileLabels,
  isYamlFile,
  MAX_THEME_FILES,
  type ThemeFileCandidate
} from './theme-file-scanner'

export function createManualWarpThemeFileCandidates(filePaths: string[]): ThemeFileCandidate[] {
  return filePaths
    .map((filePath) => ({
      path: filePath,
      label: path.basename(filePath),
      contentHashDiscriminator: true
    }))
    .sort((left, right) => {
      const labelComparison = compareThemeFileLabels(left, right)
      if (labelComparison !== 0) {
        return labelComparison
      }
      // Why: manual dialogs can return selections in click order. Sort only in
      // main so duplicate basenames get deterministic IDs without persisting paths.
      return left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
    })
}

export function manualWarpThemeContentDiscriminator(label: string, content: string): string {
  return `${label}-${createHash('sha256').update(content).digest('hex').slice(0, 12)}`
}

export async function chooseManualWarpThemeFiles(webContents?: WebContents): Promise<
  | { canceled: true }
  | {
      canceled: false
      sourceLabel: string
      files: ThemeFileCandidate[]
      skippedFiles: WarpThemeImportSkippedFile[]
    }
> {
  const ownerWindow = webContents ? BrowserWindow.fromWebContents(webContents) : null
  const options: OpenDialogOptions = {
    title: 'Import Warp Theme',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Warp theme YAML', extensions: ['yaml', 'yml'] }]
  }
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }
  const selectedYamlFiles = result.filePaths.filter(isYamlFile)
  const files = createManualWarpThemeFileCandidates(selectedYamlFiles).slice(0, MAX_THEME_FILES)
  const skippedFiles: WarpThemeImportSkippedFile[] =
    selectedYamlFiles.length > MAX_THEME_FILES
      ? [
          {
            label: 'Selected Warp themes',
            reason: `Only the first ${MAX_THEME_FILES} theme files were scanned.`
          }
        ]
      : []
  return {
    canceled: false,
    sourceLabel: files.length === 1 ? (files[0]?.label ?? 'Warp theme') : 'Selected Warp themes',
    files,
    skippedFiles
  }
}

export async function chooseManualWarpThemeFolderPath(
  webContents?: WebContents
): Promise<string | null> {
  const ownerWindow = webContents ? BrowserWindow.fromWebContents(webContents) : null
  const options: OpenDialogOptions = {
    title: 'Import Warp Theme Folder',
    properties: ['openDirectory']
  }
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]!
}
