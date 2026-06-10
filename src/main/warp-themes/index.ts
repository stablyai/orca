import { readFile, stat } from 'fs/promises'
import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource,
  WarpThemeImportSkippedFile
} from '../../shared/terminal-custom-themes'
import { makeCustomTerminalThemeSelection } from '../../shared/terminal-custom-themes'
import { getWarpThemeDirectories } from './discovery'
import { parseWarpThemeYamlWithTimeout } from './parser-runner'
import {
  sanitizeReadError,
  scanWarpThemeDirectory,
  type ThemeFileCandidate
} from './theme-file-scanner'
import {
  createPreviewOperationBudget,
  pushPreviewBudgetSkippedFile,
  type PreviewOperationBudget,
  type WarpThemePreviewOptions
} from './preview-operation-budget'
import { validateWarpThemeImportSource } from './warp-theme-import-source-validation'
import {
  chooseManualWarpThemeFiles,
  chooseManualWarpThemeFolderPath,
  manualWarpThemeContentDiscriminator
} from './manual-warp-theme-files'

const MAX_THEME_FILE_BYTES = 1_000_000

type ThemeSourceSelection =
  | { canceled: true }
  | {
      canceled: false
      sourceLabel: string
      files: ThemeFileCandidate[]
      skippedFiles: WarpThemeImportSkippedFile[]
      rootReadable?: boolean
    }

type ThemeSourceResolution = {
  selection: ThemeSourceSelection
  budget: PreviewOperationBudget
}

async function filesFromDirectory(
  directoryPath: string,
  sourceLabelOverride?: string,
  budget?: PreviewOperationBudget
): Promise<ThemeSourceSelection> {
  const { sourceLabel, rootReadable, files, skippedFiles } = await scanWarpThemeDirectory(
    directoryPath,
    budget
  )
  const effectiveSourceLabel = sourceLabelOverride ?? sourceLabel
  return {
    canceled: false,
    sourceLabel: effectiveSourceLabel,
    files: files.map((file) => ({ ...file, sourceLabel: effectiveSourceLabel })),
    skippedFiles,
    rootReadable
  }
}

async function filesFromAutoDirectories(
  budget?: PreviewOperationBudget
): Promise<ThemeSourceSelection> {
  const directories = getWarpThemeDirectories()
  let localSelection: ThemeSourceSelection | null = null
  const unreadableSkippedFiles: WarpThemeImportSkippedFile[] = []
  let autoDiscoveryExpired = false
  for (const directoryPath of directories) {
    if (budget?.isExpired()) {
      autoDiscoveryExpired = true
      break
    }
    try {
      const info = await stat(directoryPath)
      if (!info.isDirectory()) {
        continue
      }
    } catch {
      continue
    }
    const selection = await filesFromDirectory(directoryPath, 'Local Warp themes', budget)
    if (!selection.canceled && selection.rootReadable) {
      localSelection = selection
      break
    }
    if (!selection.canceled) {
      unreadableSkippedFiles.push(...selection.skippedFiles)
    }
  }
  if (localSelection) {
    return {
      canceled: false,
      sourceLabel: 'Warp themes',
      files: localSelection.files,
      skippedFiles: localSelection.skippedFiles
    }
  }
  if (autoDiscoveryExpired) {
    return {
      canceled: false,
      sourceLabel: 'Warp themes',
      files: [],
      skippedFiles: [
        {
          label: 'Warp themes',
          reason: 'Preview budget expired before local Warp theme folders could be scanned.'
        }
      ]
    }
  }
  // Why: Warp's preloaded themes live inside the Warp app binary, not on disk,
  // so an absent or empty themes folder is a genuine empty result — the
  // renderer explains this and points at Orca's built-in equivalents.
  return {
    canceled: false,
    sourceLabel: 'Warp themes',
    files: [],
    skippedFiles: unreadableSkippedFiles
  }
}

async function resolveThemeSource(
  source: WarpThemeImportSource,
  webContents?: WebContents,
  options: WarpThemePreviewOptions = {}
): Promise<ThemeSourceResolution> {
  switch (source.kind) {
    case 'auto': {
      const budget = createPreviewOperationBudget(options)
      return { selection: await filesFromAutoDirectories(budget), budget }
    }
    case 'chooseFile': {
      const selection = await chooseManualWarpThemeFiles(webContents)
      return { selection, budget: createPreviewOperationBudget(options) }
    }
    case 'chooseFolder': {
      const folderPath = await chooseManualWarpThemeFolderPath(webContents)
      const budget = createPreviewOperationBudget(options)
      return {
        selection: folderPath
          ? await filesFromDirectory(folderPath, undefined, budget)
          : { canceled: true },
        budget
      }
    }
  }
}

export async function previewWarpThemeImport(
  _store: Store,
  source: unknown = { kind: 'auto' },
  webContents?: WebContents,
  options: WarpThemePreviewOptions = {}
): Promise<WarpThemeImportPreview> {
  const validatedSource = validateWarpThemeImportSource(source)
  if (!validatedSource) {
    return {
      found: false,
      themes: [],
      skippedFiles: [],
      error: 'Invalid Warp theme import source.'
    }
  }

  const { selection, budget } = await resolveThemeSource(validatedSource, webContents, options)
  if (selection.canceled) {
    return { found: false, canceled: true, themes: [], skippedFiles: [] }
  }

  const skippedFiles = [...selection.skippedFiles]
  const themes: WarpThemeImportPreview['themes'] = []
  const idCounts = new Map<string, number>()
  const importedAt = new Date().toISOString()

  for (const [index, file] of selection.files.entries()) {
    if (budget.isExpired()) {
      pushPreviewBudgetSkippedFile(
        skippedFiles,
        selection.sourceLabel,
        budget.remainingThemeFiles(index, selection.files.length)
      )
      break
    }
    let content: string
    if (file.content !== undefined) {
      content = file.content
    } else {
      try {
        const info = await stat(file.path)
        if (!info.isFile()) {
          skippedFiles.push({ label: file.label, reason: 'Not a file.' })
          continue
        }
        if (info.size > MAX_THEME_FILE_BYTES) {
          skippedFiles.push({
            label: file.label,
            reason: `File is too large to import (${info.size} bytes, limit ${MAX_THEME_FILE_BYTES}).`
          })
          continue
        }
        content = await readFile(file.path, 'utf-8')
      } catch {
        skippedFiles.push({
          label: file.label,
          reason: sanitizeReadError('Could not read file.')
        })
        continue
      }
    }
    if (budget.isExpired()) {
      pushPreviewBudgetSkippedFile(
        skippedFiles,
        selection.sourceLabel,
        budget.remainingThemeFiles(index, selection.files.length)
      )
      break
    }

    const parsed = await parseWarpThemeYamlWithTimeout(
      content,
      file.label,
      {
        idDiscriminator:
          file.idDiscriminator ||
          (file.contentHashDiscriminator
            ? manualWarpThemeContentDiscriminator(file.label, content)
            : file.label || file.sourceLabel || selection.sourceLabel),
        importedAt,
        sourceLabel: file.sourceLabel ?? selection.sourceLabel
      },
      {
        timeoutMs: budget.remainingMs()
      }
    )
    if (!parsed.ok) {
      skippedFiles.push({ label: file.label, reason: parsed.reason })
      continue
    }

    const count = idCounts.get(parsed.theme.id) ?? 0
    idCounts.set(parsed.theme.id, count + 1)
    if (count > 0) {
      const id = `${parsed.theme.id}-${count + 1}`
      themes.push({
        ...parsed.theme,
        id,
        selectionValue: makeCustomTerminalThemeSelection(id)
      })
      continue
    }
    themes.push(parsed.theme)
  }

  // Why: an empty result carries no error — the renderer owns the localized
  // empty-state copy; `error` is reserved for genuine failures.
  return {
    found: themes.length > 0,
    sourceLabel: selection.sourceLabel,
    themes,
    skippedFiles
  }
}
