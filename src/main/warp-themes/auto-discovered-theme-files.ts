import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { WarpThemeImportSkippedFile } from '../../shared/terminal-custom-themes'
import { getWarpThemeDirectories, warpThemeSourceLabelForDirectory } from './discovery'
import type { PreviewOperationBudget } from './preview-operation-budget'
import { filesFromDirectory, type ThemeSourceSelection } from './theme-source-selection'
import { MAX_THEME_FILES, type ThemeFileCandidate } from './theme-file-scanner'

function themeFileCanonicalFallback(filePath: string): string {
  return path.normalize(path.resolve(filePath))
}

async function themeFileDedupeKey(filePath: string): Promise<string> {
  try {
    return path.normalize(await realpath(filePath))
  } catch {
    return themeFileCanonicalFallback(filePath)
  }
}

async function appendUniqueThemeFiles(
  targetFiles: ThemeFileCandidate[],
  seenFilePaths: Set<string>,
  candidateFiles: ThemeFileCandidate[]
): Promise<boolean> {
  let capped = false
  for (const file of candidateFiles) {
    const dedupeKey = await themeFileDedupeKey(file.path)
    if (seenFilePaths.has(dedupeKey)) {
      continue
    }
    seenFilePaths.add(dedupeKey)
    if (targetFiles.length < MAX_THEME_FILES) {
      targetFiles.push(file)
    } else {
      capped = true
      break
    }
  }
  return capped
}

async function isDirectoryPath(directoryPath: string): Promise<boolean> {
  try {
    const info = await stat(directoryPath)
    return info.isDirectory()
  } catch {
    return false
  }
}

async function directoryHasThemeFileCandidate(
  directoryPath: string,
  budget?: PreviewOperationBudget
): Promise<boolean> {
  if (!(await isDirectoryPath(directoryPath))) {
    return false
  }
  const selection = await filesFromDirectory(
    directoryPath,
    warpThemeSourceLabelForDirectory(directoryPath),
    budget,
    1,
    false
  )
  return !selection.canceled && selection.files.length > 0
}

export async function filesFromAutoDirectories(
  budget?: PreviewOperationBudget
): Promise<ThemeSourceSelection> {
  const directories = getWarpThemeDirectories()
  const mergedFiles: ThemeFileCandidate[] = []
  const seenFilePaths = new Set<string>()
  const skippedFiles: WarpThemeImportSkippedFile[] = []
  let autoDiscoveryExpired = false
  let globalThemeFileLimitHit = false
  for (const directoryPath of directories) {
    if (budget?.isExpired()) {
      autoDiscoveryExpired = true
      break
    }
    const remainingThemeFileSlots = MAX_THEME_FILES - mergedFiles.length
    if (remainingThemeFileSlots <= 0) {
      globalThemeFileLimitHit =
        (await directoryHasThemeFileCandidate(directoryPath, budget)) || globalThemeFileLimitHit
      if (budget?.isExpired()) {
        autoDiscoveryExpired = true
      }
      if (globalThemeFileLimitHit || autoDiscoveryExpired) {
        break
      }
      continue
    }
    if (!(await isDirectoryPath(directoryPath))) {
      continue
    }
    const selection = await filesFromDirectory(
      directoryPath,
      warpThemeSourceLabelForDirectory(directoryPath),
      budget,
      MAX_THEME_FILES,
      false
    )
    if (selection.canceled) {
      continue
    }
    globalThemeFileLimitHit =
      (await appendUniqueThemeFiles(mergedFiles, seenFilePaths, selection.files)) ||
      selection.themeFileLimitHit ||
      globalThemeFileLimitHit
    skippedFiles.push(...selection.skippedFiles)
  }
  if (autoDiscoveryExpired) {
    skippedFiles.push({
      label: 'Warp themes',
      reason: 'Preview budget expired before local Warp theme folders could be scanned.'
    })
  }

  if (globalThemeFileLimitHit) {
    skippedFiles.push({
      label: 'Warp themes',
      reason: `Only the first ${MAX_THEME_FILES} theme files were scanned.`
    })
  }

  // Why: Warp's preloaded themes live inside the Warp app binary, not on disk,
  // so an absent or empty themes folder is a genuine empty result — the
  // renderer explains this and points at Orca's built-in equivalents.
  return {
    canceled: false,
    sourceLabel: 'Warp themes',
    files: mergedFiles,
    skippedFiles
  }
}
