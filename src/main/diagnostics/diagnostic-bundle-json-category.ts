import type {
  DiagnosticBundleCategory,
  DiagnosticBundleCategoryResult
} from '../../shared/diagnostic-bundle-export-types'
import { redactString } from '../observability/redactor'

export async function collectDiagnosticJsonCategory(
  record: (result: DiagnosticBundleCategoryResult) => void,
  addEntry: (category: DiagnosticBundleCategory, path: string, content: Buffer | string) => void,
  category: DiagnosticBundleCategory,
  path: string,
  collect: () => Promise<unknown> | unknown
): Promise<void> {
  try {
    const value = await collect()
    if (isUnsupportedSummary(value)) {
      record({
        category,
        status: 'skipped',
        reason: sanitizeDiagnosticCategoryReason(value.reason),
        files: []
      })
      return
    }
    addEntry(category, path, makeDiagnosticJsonContent(value))
    record({ category, status: 'included', files: [path] })
  } catch (error) {
    record({
      category,
      status: 'error',
      reason: sanitizeDiagnosticCategoryError(error),
      files: []
    })
  }
}

export function makeDiagnosticJsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function sanitizeDiagnosticCategoryError(error: unknown): string {
  return sanitizeDiagnosticCategoryReason(error instanceof Error ? error.message : String(error))
}

function isUnsupportedSummary(value: unknown): value is { supported: false; reason?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { supported?: unknown }).supported === false
  )
}

function sanitizeDiagnosticCategoryReason(reason: string | undefined): string {
  const text = reason && reason.trim().length > 0 ? reason : 'unknown'
  return redactString(text).slice(0, 500)
}
