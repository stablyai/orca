import { build } from 'esbuild'
import { appendFileSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  externalNativeAddons,
  ORCAD_CHILD_ENTRY_POINTS,
  ORCAD_ENTRY_POINT
} from './orcad-entry-build.mjs'
import { bunProfileTestPaths } from './bun-profile-test-paths.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const BUILD_SCRIPTS = [
  'config/scripts/build-orcad-bun.mjs',
  'config/scripts/build-orcad.mjs',
  'config/scripts/build-windows-process-tree-relay-addon.mjs',
  'config/scripts/run-bun-profile-tests.mjs',
  'config/vitest.config.ts',
  'config/scripts/happy-dom-offscreen-canvas.ts',
  'config/scripts/happy-dom-mutation-observer-retention.ts',
  'config/scripts/vitest-host-ports-setup.ts'
]
const ALWAYS_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs',
  'tsconfig.json',
  '.github/workflows/bun-profile-tests.yml',
  'config/scripts/bun-profile-change-scope.mjs',
  'config/scripts/bun-profile-change-scope.test.mjs'
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

export function discoverBunProfileTests(root = ROOT) {
  const selectors = bunProfileTestPaths({ artifact: true })
  return globSync(
    ['src/**/*.test.{ts,tsx}', 'config/scripts/**/*.test.{ts,mjs}', 'tests/e2e/**/*.unit.test.ts'],
    { cwd: root }
  )
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => selectors.some((selector) => file.includes(selector)))
    .sort()
}

export async function collectBunProfileInputs({ root = ROOT, entryPoints } = {}) {
  const entries = entryPoints ?? [
    ORCAD_ENTRY_POINT,
    ...Object.values(ORCAD_CHILD_ENTRY_POINTS),
    ...BUILD_SCRIPTS,
    ...discoverBunProfileTests(root)
  ]
  const result = await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    outdir: resolve(root, '.bun-profile-scope'),
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

export async function classifyBunProfileChanges(changedFiles, collect = collectBunProfileInputs) {
  if (changedFiles.length === 0) {
    return { shouldRun: true, reason: 'No complete changed-file evidence' }
  }
  const selectors = bunProfileTestPaths({ artifact: true })
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
      reason: matched ? `Runtime or test dependency changed: ${matched}` : 'No Bun inputs changed'
    }
  } catch (error) {
    return { shouldRun: true, reason: `Dependency graph unavailable: ${String(error)}` }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changedFiles = readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean)
  const result = await classifyBunProfileChanges(changedFiles)
  console.log(result.reason)
  const output = `should_run=${String(result.shouldRun)}\n`
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, output)
  } else {
    process.stdout.write(output)
  }
}
