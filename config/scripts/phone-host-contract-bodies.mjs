import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'

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

// `--run <paths and flags>` runs the root type-aware pass itself, for CI and the local audit alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = rootTypeAwareLintArgs()
  if (!args.some((arg) => arg.startsWith('--ignore-pattern='))) {
    throw new Error(`No contract bodies derived from ${NODE_TEST_PROJECT}`)
  }
  if (process.argv[2] !== '--run') {
    console.log(args.join('\n'))
  } else {
    const { command, prefixArgs } = resolveOxlintInvocation(repoRoot)
    const result = spawnSync(command, [...prefixArgs, ...args, ...process.argv.slice(3)], {
      cwd: repoRoot,
      stdio: 'inherit'
    })
    process.exit(result.status ?? 1)
  }
}
