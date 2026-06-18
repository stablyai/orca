import { readFile, stat } from 'fs/promises'
import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../../shared/terminal-custom-themes'
import { makeCustomTerminalThemeSelection } from '../../shared/terminal-custom-themes'
import { parseWarpThemeYamlWithTimeout } from './parser-runner'
import { sanitizeReadError } from './theme-file-scanner'
import {
  createPreviewOperationBudget,
  pushPreviewBudgetSkippedFile,
  type PreviewOperationBudget,
  type WarpThemePreviewOptions
} from './preview-operation-budget'
import { validateWarpThemeImportSource } from './warp-theme-import-source-validation'
import { filesFromAutoDirectories } from './auto-discovered-theme-files'
import { filesFromDirectory, type ThemeSourceSelection } from './theme-source-selection'
import {
  chooseManualWarpThemeFiles,
  chooseManualWarpThemeFolderPath,
  manualWarpThemeContentDiscriminator
} from './manual-warp-theme-files'

const MAX_THEME_FILE_BYTES = 1_000_000

type ThemeSourceResolution = {
  selection: ThemeSourceSelection
  budget: PreviewOperationBudget
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
