import type { AutomationRun } from '../../../shared/automations/history/automation-run'

// orca.yaml setup is small; a larger value is not worth keeping on every run record.
const MAX_SETUP_SKIPPED_CONTENT_CHARS = 64 * 1024

/** Keeps a run's skipped setup content only when it is well formed; reviewing it re-hashes anyway. */
export function normalizeSetupSkippedContent(
  value: unknown
): Pick<AutomationRun, 'setupSkippedContent'> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const contentHash = 'contentHash' in value ? value.contentHash : undefined
  const scriptContent = 'scriptContent' in value ? value.scriptContent : undefined
  if (
    typeof contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(contentHash) ||
    typeof scriptContent !== 'string' ||
    !scriptContent ||
    scriptContent.length > MAX_SETUP_SKIPPED_CONTENT_CHARS
  ) {
    return {}
  }
  return { setupSkippedContent: { contentHash, scriptContent } }
}
