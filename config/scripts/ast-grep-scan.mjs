import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'

export const AST_GREP_CONFIG = 'config/sgconfig.yml'
export const AST_GREP_SCAN_PATHS = ['src', 'config', 'tests', 'mobile']

// Why the platform binary: the package's `ast-grep` bin is either a JS launcher or (after its
// postinstall) the native binary, and on Windows a .cmd shim Node refuses to spawn without a shell.
// Resolved from this script, not the scanned root, so scans of temp or nested roots still find it.
export function resolveAstGrepBinary() {
  const binary = createRequire(import.meta.url)('@ast-grep/cli/postinstall.js').resolveBinaryPath()
  if (!binary) {
    throw new Error('No @ast-grep/cli binary for this platform; run pnpm install.')
  }
  return binary
}

/** Runs `ast-grep scan` and returns its JSON matches; exit status 1 only means error findings. */
export function scanAstGrep(root, { filter, minSeverity, paths = AST_GREP_SCAN_PATHS } = {}) {
  const args = ['scan', '--config', AST_GREP_CONFIG, '--json=stream', '--color', 'never']
  if (filter) {
    args.push('--filter', filter)
  }
  if (minSeverity) {
    args.push('--min-severity', minSeverity)
  }
  const result = spawnSync(resolveAstGrepBinary(), [...args, '--', ...paths], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(result.stderr)
    throw new Error(`ast-grep scan failed with exit code ${result.status}.`)
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

/** Per-language twins share one rule id with a `-tsx` suffix; report them as one rule. */
export function baseRuleId(ruleId) {
  return ruleId.replace(/-tsx$/, '')
}
