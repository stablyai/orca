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

// Launch, restart-continuation and process-ownership code. Ownership reads only time out on macOS (libproc/ps;
// Linux reads /proc), so a change here also needs the launch burst on a Mac.
const LAUNCH_PATH_PREFIXES = [
  'src/main/provider-process/',
  'src/main/native-chat/agent-launch/',
  'src/main/native-chat/agent-session-wire/recovery/',
  'src/main/claude/child-process/',
  'src/main/claude/sdk-transport/',
  'src/main/claude/structured/launch/',
  'src/main/claude/structured/startup/',
  'src/main/codex/structured/session-lifecycle/',
  'src/main/acp/process/',
  'src/main/acp/session/start/',
  'src/main/pty/process-retirement/',
  'src/shared/process-observation/',
  'native/provider-exec/',
  'config/provider-exec-resources.cjs',
  'config/scripts/performance/fleet-gate/fleet-gate-launch-burst.mjs'
]

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

export function isLaunchPath(file) {
  if (COLD_PATTERNS.some((pattern) => pattern.test(file))) {
    return false
  }
  return LAUNCH_PATH_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))
}

/** endpoints: what differs between the two trees (two builds); otherwise what the head branch changed since base. */
export function changedFiles(base, head, cwd, endpoints = false) {
  const range = endpoints ? [base, head] : [`${base}...${head}`]
  // --no-renames: a file moved out of a hot path shows as its deletion too, not only its new home.
  const output = execFileSync('git', ['diff', '--name-only', '--no-renames', ...range], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return output.split('\n').filter(Boolean)
}

/** Fails open: a diff that can't be resolved counts as touching every hot path, so the gate runs. */
export function hotPathChanges(base, head, cwd, filter = isHotPath, endpoints = false) {
  try {
    return changedFiles(base, head, cwd, endpoints).filter(filter)
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
  if (args.includes('--launch-paths')) {
    const launch = hotPathChanges(base, head, process.cwd(), isLaunchPath)
    console.log(
      launch.length === 0
        ? 'mac burst: not needed (no launch, restart or process-ownership changes)'
        : `mac burst: required (${launch.length} launch file(s), e.g. ${launch[0]})`
    )
    // Exit 11 so the wrapper can branch on "needs the macOS burst".
    process.exitCode = launch.length === 0 ? 0 : 11
    return
  }
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
