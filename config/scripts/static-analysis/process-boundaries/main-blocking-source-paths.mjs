import { existsSync, readFileSync } from 'node:fs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

// Exact entry files only: dependencies remain guarded, even when a worker imports them.
const entries = JSON.parse(
  readFileSync(new URL('../../../main-blocking-worker-entries.json', import.meta.url), 'utf8')
)
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
    !file.endsWith('.d.ts') &&
    !isTestOnlySourcePath(file) &&
    !Object.hasOwn(entries, file)
  )
}
