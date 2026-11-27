import { existsSync, readFileSync } from 'node:fs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

// Entry files are exempt here; main-blocking-import-graph.mjs also exempts modules only these entries import.
const entries = JSON.parse(
  readFileSync(new URL('../../../main-blocking-worker-entries.json', import.meta.url), 'utf8')
)
export const MAIN_BLOCKING_WORKER_ENTRIES = entries
for (const [file, reason] of Object.entries(entries)) {
  if (
    !file.startsWith('src/main/') ||
    !reason.trim() ||
    !existsSync(new URL(`../../../../${file}`, import.meta.url))
  ) {
    throw new Error(`Invalid worker entry: ${file}`)
  }
}

export function isMainBlockingSource(file) {
  return (
    /\.[cm]?[jt]sx?$/.test(file) &&
    !/\.d\.[cm]?ts$/.test(file) &&
    !isTestOnlySourcePath(file) &&
    !Object.hasOwn(entries, file)
  )
}
