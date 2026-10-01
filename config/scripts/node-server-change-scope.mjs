import { build } from 'esbuild'
import { appendFileSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  externalNativeAddons,
  ORCAD_CHILD_ENTRY_POINTS,
  ORCAD_ENTRY_POINT
} from './orcad-entry-build.mjs'
import { nodeServerTestPaths } from './node-server-test-paths.mjs'
import { nodeServerQualification } from './node-server-qualification.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const BUILD_SCRIPTS = [
  'config/scripts/build-orcad-node.mjs',
  'config/scripts/server-build-target.mjs',
  'config/scripts/pinned-node-downloads.mjs',
  'config/scripts/build-orcad.mjs',
  'config/scripts/build-orcad-prebuilds.mjs',
  'config/scripts/orcad-prebuild-smoke-child.cjs',
  'config/scripts/build-windows-process-tree-relay-addon.mjs',
  'config/scripts/run-node-server-tests.mjs',
  'config/vitest.config.ts',
  'config/scripts/happy-dom-offscreen-canvas.ts',
  'config/scripts/happy-dom-mutation-observer-retention.ts',
  'config/scripts/vitest-host-ports-setup.ts',
  'config/scripts/vitest-real-agent-home-write-guard.ts'
]
const ALWAYS_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs',
  'tsconfig.json',
  '.github/workflows/node-server-tests.yml',
  'config/scripts/node-server-change-scope.mjs',
  'config/scripts/node-server-change-scope.test.mjs',
  'config/scripts/node-server-qualification.mjs',
  'config/scripts/node-server-qualification.test.mjs'
])
const ALWAYS_PREFIXES = [
  '.github/actions/install-node-dependencies/',
  // These areas also contain worker paths and fixtures opened without an import.
  'src/main/persistence/',
  'src/main/sqlite/',
  'src/main/orcad/',
  'src/main/daemon/pty-subprocess/',
  'src/main/providers/',
  'config/patches/',
  'config/tsconfig',
  'native/',
  'resources/licenses/ripgrep/'
]

export function discoverNodeServerTests(root = ROOT) {
  const selectors = nodeServerTestPaths({ artifact: true, crossRuntime: true })
  return globSync(
    ['src/**/*.test.{ts,tsx}', 'config/scripts/**/*.test.{ts,mjs}', 'tests/e2e/**/*.unit.test.ts'],
    { cwd: root }
  )
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => selectors.some((selector) => file.includes(selector)))
    .sort()
}

export async function collectNodeServerInputs({ root = ROOT, entryPoints } = {}) {
  const entries = entryPoints ?? [
    ORCAD_ENTRY_POINT,
    ...Object.values(ORCAD_CHILD_ENTRY_POINTS),
    ...BUILD_SCRIPTS,
    ...discoverNodeServerTests(root)
  ]
  const result = await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    outdir: resolve(root, '.node-server-scope'),
    platform: 'node',
    format: 'esm',
    splitting: true,
    packages: 'external',
    loader: { '.svg': 'empty', '.png': 'empty', '.webp': 'empty', '.css': 'empty' },
    plugins: [externalNativeAddons],
    metafile: true,
    logLevel: 'silent'
  })
  if (result.warnings.length > 0) {
    throw new Error(result.warnings.map((warning) => warning.text).join('\n'))
  }
  return new Set(
    Object.keys(result.metafile.inputs).map((file) =>
      file.replaceAll('\\', '/').replace(/\?.*$/, '')
    )
  )
}

export async function classifyNodeServerChanges(changedFiles, collect = collectNodeServerInputs) {
  if (changedFiles.length === 0) {
    return { shouldRun: true, reason: 'No complete changed-file evidence' }
  }
  const selectors = nodeServerTestPaths({ artifact: true, crossRuntime: true })
  const forced = changedFiles.find(
    (file) =>
      ALWAYS_FILES.has(file) ||
      ALWAYS_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      selectors.some((selector) => file.includes(selector))
  )
  if (forced) {
    return { shouldRun: true, reason: `Build or CI input changed: ${forced}` }
  }
  try {
    const inputs = await collect()
    const matched = changedFiles.find((file) => inputs.has(file))
    return {
      shouldRun: Boolean(matched),
      reason: matched
        ? `Runtime or test dependency changed: ${matched}`
        : 'No headless-server inputs changed'
    }
  } catch (error) {
    return {
      shouldRun: true,
      graphUnavailable: true,
      reason: `Dependency graph unavailable: ${String(error)}`
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changedFiles = readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean)
  const result = await classifyNodeServerChanges(changedFiles)
  console.log(result.reason)
  const policy = nodeServerQualification(changedFiles, result)
  const output = `should_run=${result.shouldRun}\nqualification=${policy.qualification}\nrunners=${JSON.stringify(policy.runners)}\n`
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, output)
  } else {
    process.stdout.write(output)
  }
}
