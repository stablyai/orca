import { appendFileSync, existsSync, globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { collectUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { readNodeTestBodies } from './phone-host-contract-bodies.mjs'

// Decides whether a change can alter the phone/host contract bodies' declarations or their typed lint,
// so the static job installs the phone project and runs both producers only for those changes.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const HOST_PRODUCER = 'config/tsconfig.test.mobile-host-declarations.json'
const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '.d.ts', '.mts', '.mjs', '.js', '.json']
const toPosix = (filePath) => filePath.replaceAll('\\', '/')

// The program configs both producers and the consumer extend, the lint rules, and the tools this
// decision and the checker run; none of them is reached through a source import.
export const CONTRACT_LINT_TOOL_FILES = new Set([
  'tsconfig.json',
  'package.json',
  'pnpm-lock.yaml',
  '.github/workflows/pr.yml',
  HOST_PRODUCER,
  'config/tsconfig.test.pane-launch.json',
  'config/tsconfig.web.json',
  'config/oxlint-code-quality-type-aware.json',
  'config/scripts/ci-unit-dependency-graph.mjs',
  'config/scripts/oxc-cli-invocation.mjs',
  'config/scripts/oxlint-cli-invocation.mjs',
  'config/scripts/phone-host-contract-bodies.mjs',
  'config/scripts/phone-host-contract-lint-scope.mjs',
  'config/scripts/run-typecheck-projects-in-parallel.mjs',
  'config/scripts/tsrs-typecheck-compiler.mjs'
])

// Inputs that change the declarations without a static import edge: the phone project (both its
// producer and the consumer live there), the host producer's include, and ambient or native-addon declarations.
function isDirectInput(file, bodies) {
  return (
    file.startsWith('mobile/') ||
    file.startsWith('src/shared/') ||
    ((file.startsWith('src/') || file.startsWith('native/')) && file.endsWith('.d.ts')) ||
    bodies.has(file) ||
    CONTRACT_LINT_TOOL_FILES.has(file)
  )
}

// The host producer's roots, the desktop bodies, and every desktop file a phone source imports.
function producerSeeds(root) {
  const config = JSON.parse(readFileSync(path.join(root, HOST_PRODUCER), 'utf8'))
  const seeds = [
    ...config.files.map((file) => path.posix.normalize(path.posix.join('config', file))),
    ...readNodeTestBodies(root)
  ]
  for (const file of globSync('mobile/src/**/*.{ts,tsx}', {
    cwd: root,
    exclude: ['**/node_modules/**']
  })) {
    const source = readFileSync(path.join(root, file), 'utf8')
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      const target = fileName.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(file)), fileName))
        : ''
      if (target.startsWith('src/')) {
        seeds.push(target)
      }
    }
  }
  return seeds
}

// Every source the producers can reach by import, following the unit graph's own resolution.
export function contractProducerClosure(
  root = repoRoot,
  graph = collectUnitDependencyGraph(root, { ownership: false })
) {
  const forward = new Map()
  for (const [input, consumers] of graph.reverse) {
    for (const consumer of consumers) {
      forward.set(consumer, (forward.get(consumer) ?? new Set()).add(input))
    }
  }
  const queue = producerSeeds(root).flatMap((seed) =>
    RESOLUTION_SUFFIXES.map((suffix) => seed + suffix).filter((file) => graph.files.has(file))
  )
  const closure = new Set()
  for (const file of queue) {
    if (!closure.has(file)) {
      closure.add(file)
      queue.push(...(forward.get(file) ?? []))
    }
  }
  return closure
}

// An empty or unreadable diff, or a deleted source, fails closed to running the check.
export function needsContractLint(
  changedFiles,
  root = repoRoot,
  closure = () => contractProducerClosure(root)
) {
  if (changedFiles.length === 0) {
    return true
  }
  const bodies = new Set(readNodeTestBodies(root))
  if (changedFiles.some((file) => isDirectInput(file, bodies))) {
    return true
  }
  const sources = changedFiles.filter((file) => file.startsWith('src/'))
  if (sources.some((file) => !existsSync(path.join(root, file)))) {
    return true
  }
  if (sources.length === 0) {
    return false
  }
  const reachable = closure()
  return sources.some((file) => reachable.has(file))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readFileSync(process.argv[2], 'utf8')
  const files = input.split(/[\0\n]/).filter(Boolean)
  const line = `run=${needsContractLint(files)}`
  console.log(line)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
  }
}
