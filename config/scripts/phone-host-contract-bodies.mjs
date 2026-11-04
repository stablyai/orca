import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
export const NODE_TEST_PROJECT = 'mobile/tsconfig.test.node.json'
export const CONTRACT_LINT_CONFIG = 'config/oxlint-code-quality-type-aware.json'
const toPosix = (filePath) => filePath.replaceAll('\\', '/')

// The checked bodies are the node test config's non-declaration roots, so no second list names them.
// Each is normalized to a repository path; phone bodies sit under mobile/, desktop ones under src/.
export function readNodeTestBodies(root = repoRoot) {
  const config = JSON.parse(readFileSync(path.join(root, NODE_TEST_PROJECT), 'utf8'))
  const base = path.posix.dirname(NODE_TEST_PROJECT)
  return config.files
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .map((file) => path.posix.normalize(path.posix.join(base, toPosix(file))))
    .sort()
}

// Phone test roots, relative to mobile/, run under the phone's Bun role; the rest stay desktop-owned.
export function partitionNodeTestBodies(bodies) {
  const local = bodies.filter((file) => file.startsWith('mobile/') && /\.test\.tsx?$/.test(file))
  return {
    local: local.map((file) => file.slice('mobile/'.length)),
    external: bodies.filter((file) => !file.startsWith('mobile/'))
  }
}

// The desktop bodies' imports exist only as emitted declarations, so the root type-aware pass leaves
// them to the checker's declaration-owned pass, which lints each of them once.
export function rootTypeAwareLintArgs(root = repoRoot) {
  const { external } = partitionNodeTestBodies(readNodeTestBodies(root))
  return [
    '--type-aware',
    '--config',
    CONTRACT_LINT_CONFIG,
    ...external.map((body) => `--ignore-pattern=${body}`)
  ]
}

// Inputs of the bodies' declaration-owned lint besides phone and desktop sources: its program and rules.
const CONTRACT_LINT_TOOL_FILES = new Set([
  'tsconfig.json',
  'package.json',
  'pnpm-lock.yaml',
  'config/tsconfig.test.mobile-host-declarations.json',
  'config/tsconfig.test.pane-launch.json',
  CONTRACT_LINT_CONFIG,
  'config/scripts/oxc-cli-invocation.mjs',
  'config/scripts/oxlint-cli-invocation.mjs',
  'config/scripts/phone-host-contract-bodies.mjs',
  'config/scripts/run-typecheck-projects-in-parallel.mjs'
])

export function needsMobileDependencies(changedFiles, root = repoRoot) {
  // Changed-mobile type-aware lint needs mobile/node_modules: root-only install resolves mobile types as error and produces phantom findings.
  // The contract bodies' lint needs both declaration producers, so its desktop inputs need the phone install too.
  if (changedFiles.length === 0 || changedFiles.some((file) => file.startsWith('mobile/'))) {
    return true
  }
  const bodies = new Set(readNodeTestBodies(root))
  return changedFiles.some(
    (file) =>
      (file.startsWith('src/') && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) ||
      bodies.has(file) ||
      CONTRACT_LINT_TOOL_FILES.has(file)
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(rootTypeAwareLintArgs().join('\n'))
}
