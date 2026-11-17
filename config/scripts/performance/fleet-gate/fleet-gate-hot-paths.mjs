#!/usr/bin/env node
// Decides whether a change can move fleet-scale message rates: IPC, stores, session/runtime sync, main process.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const HOT_PATH_PREFIXES = [
  'src/main/',
  'src/preload/',
  'src/shared/',
  'src/renderer/src/store/',
  'src/renderer/src/runtime/',
  'src/renderer/src/hooks/',
  'config/scripts/performance/fleet-gate/'
]

const HOT_PATH_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'electron.vite.config.ts'])

// Test, fixture, doc and locale edits can't change what the shipped app sends or wakes.
const COLD_PATTERNS = [
  /\.(test|spec|performance\.test|unit\.test)\.[cm]?[jt]sx?$/,
  /\.test-d\.ts$/,
  /(^|\/)__(tests|fixtures|mocks)__\//,
  /(^|\/)test-support\//,
  /-fixture\.[cm]?[jt]sx?$/,
  /\.(md|mdx|txt|png|jpe?g|svg|gif|webp)$/,
  /(^|\/)locales?\//
]

export function isHotPath(file) {
  if (COLD_PATTERNS.some((pattern) => pattern.test(file))) {
    return false
  }
  return HOT_PATH_FILES.has(file) || HOT_PATH_PREFIXES.some((prefix) => file.startsWith(prefix))
}

export function changedFiles(base, head, cwd) {
  const output = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return output.split('\n').filter(Boolean)
}

/** Fails open: a diff that can't be resolved counts as touching every hot path, so the gate runs. */
export function hotPathChanges(base, head, cwd) {
  try {
    return changedFiles(base, head, cwd).filter(isHotPath)
  } catch (error) {
    console.log(
      `hot-path filter couldn't diff ${base}...${head} (${String(error?.message ?? error).split('\n')[0]}); running the gate`
    )
    return ['<unresolved diff>']
  }
}

function main() {
  const args = process.argv.slice(2)
  const read = (flag, fallback) => {
    const index = args.indexOf(flag)
    return index === -1 ? fallback : args[index + 1]
  }
  const head = read('--head', 'HEAD')
  const base = read('--base', 'origin/main')
  const hot = hotPathChanges(base, head, process.cwd())
  if (hot.length === 0) {
    console.log('skipped: no hot-path changes')
    return
  }
  console.log(`hot-path changes (${hot.length}):`)
  for (const file of hot.slice(0, 20)) {
    console.log(`  ${file}`)
  }
  if (hot.length > 20) {
    console.log(`  … ${hot.length - 20} more`)
  }
  // Exit 10 so callers can branch on "needs the gate" without parsing output.
  process.exitCode = 10
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main()
}
