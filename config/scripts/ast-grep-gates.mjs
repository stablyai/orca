// One ast-grep scan for both gates: the lint gate (warning and up) and the flaky-test ratchet (`test-*` rules).
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  AST_GREP_CONFIG,
  AST_GREP_SCAN_PATHS,
  resolveAstGrepBinary,
  scanAstGrep
} from './ast-grep-scan.mjs'
import { main as checkFlakyTestPatterns } from './check-flaky-test-pattern-ratchet.mjs'

const LINT_SEVERITIES = new Set(['error', 'warning'])
// Windows caps a command line near 32K characters; past this, rescan the whole tree.
const MAX_PATH_ARGUMENT_CHARS = 24_000

export function lintFindingFiles(matches) {
  return [
    ...new Set(
      matches
        .filter((match) => LINT_SEVERITIES.has(match.severity))
        .map((match) => match.file.split('\\').join('/'))
    )
  ].sort()
}

// Rules match file by file, so rescanning only the reported files gives ast-grep's own report and exit status.
function reportLintFindings(root, files, format) {
  const paths =
    files.reduce((total, file) => total + file.length + 1, 0) <= MAX_PATH_ARGUMENT_CHARS
      ? files
      : AST_GREP_SCAN_PATHS
  const result = spawnSync(
    resolveAstGrepBinary(),
    [
      'scan',
      '--config',
      AST_GREP_CONFIG,
      '--min-severity',
      'warning',
      ...(format ? ['--format', format] : []),
      '--',
      ...paths
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  )
  if (result.error) {
    throw result.error
  }
  return result.status ?? 1
}

export function main(root = process.cwd(), argv = []) {
  const format = argv
    .find((argument) => argument.startsWith('--format='))
    ?.slice('--format='.length)
  const matches = scanAstGrep(root)
  const files = lintFindingFiles(matches)
  const lint = files.length > 0 ? reportLintFindings(root, files, format) : 0
  const flaky = checkFlakyTestPatterns(root, undefined, matches)
  return Math.max(lint, flaky)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.cwd(), process.argv.slice(2))
}
