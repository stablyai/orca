import type { DiagnosticBundleExportResult } from '../shared/diagnostic-bundle-export-types'

export function formatDiagnosticBundleExportResult(result: DiagnosticBundleExportResult): string {
  const lines = [
    `bundleId: ${result.bundleId}`,
    `outputPath: ${result.outputPath}`,
    `bytes: ${result.bytes}`,
    `files: ${result.fileCount}`,
    `includedCategories: ${result.includedCategories.join(', ') || 'none'}`
  ]
  if (result.skippedCategories.length > 0) {
    lines.push(
      `skippedCategories: ${result.skippedCategories
        .map((entry) => `${entry.category}${entry.reason ? ` (${entry.reason})` : ''}`)
        .join(', ')}`
    )
  }
  if (result.errorCategories.length > 0) {
    lines.push(
      `errorCategories: ${result.errorCategories
        .map((entry) => `${entry.category}${entry.reason ? ` (${entry.reason})` : ''}`)
        .join(', ')}`
    )
  }
  return lines.join('\n')
}
