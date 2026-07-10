import type { WarpThemeImportSkippedFile } from '../../shared/terminal-custom-themes'
import type { WarpThemeScanBudget } from './theme-file-scanner'

const DEFAULT_PREVIEW_BUDGET_MS = 5_000

export type WarpThemePreviewOptions = {
  operationBudgetMs?: number
  now?: () => number
}

export type PreviewOperationBudget = WarpThemeScanBudget & {
  remainingMs: () => number
  remainingThemeFiles: (scheduledCount: number, totalCount: number) => number
}

export function createPreviewOperationBudget(
  options: WarpThemePreviewOptions = {}
): PreviewOperationBudget {
  const now = options.now ?? Date.now
  const budgetMs = options.operationBudgetMs ?? DEFAULT_PREVIEW_BUDGET_MS
  const deadline = now() + Math.max(0, budgetMs)
  return {
    isExpired: () => now() >= deadline,
    remainingMs: () => Math.max(0, deadline - now()),
    remainingThemeFiles: (scheduledCount, totalCount) => Math.max(0, totalCount - scheduledCount)
  }
}

export function pushPreviewBudgetSkippedFile(
  skippedFiles: WarpThemeImportSkippedFile[],
  sourceLabel: string,
  remainingCount: number
): void {
  skippedFiles.push({
    label: sourceLabel,
    reason:
      remainingCount > 0
        ? `Preview budget expired before ${remainingCount} theme file${
            remainingCount === 1 ? '' : 's'
          } could be parsed.`
        : 'Preview budget expired before all theme files could be parsed.'
  })
}
