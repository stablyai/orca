import { appendFileSync, globSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nodeServerTestPaths } from './node-server-test-paths.mjs'
import { nodeServerQualification } from './node-server-qualification.mjs'
import { classifyNativeCompatChanges } from './node-server-native-compat-scope.mjs'

const ROOT = resolve(import.meta.dirname, '../../../..')
const BUILD_SCRIPTS = [
  'config/scripts/orcad-distribution/prebuilds/build-orcad-node.mjs',
  'config/scripts/orcad-distribution/prebuilds/server-build-target.mjs',
  'config/scripts/orcad-distribution/prebuilds/pinned-node-downloads.mjs',
  'config/scripts/orcad-distribution/server-bundle/build-orcad.mjs',
  'config/scripts/orcad-distribution/prebuilds/build-orcad-prebuilds.mjs',
  'config/scripts/orcad-distribution/prebuilds/orcad-windows-prebuild-cache.mjs',
  'config/scripts/orcad-distribution/prebuilds/orcad-prebuild-smoke-child.cjs',
  'config/scripts/native-build/windows/build-windows-process-tree-addon.mjs',
  'config/scripts/native-build/windows/build-windows-cli-launcher.mjs',
  'config/scripts/native-build/windows/build-windows-security-addon.mjs',
  'config/scripts/ci/unit-selection/run-node-server-tests.mjs',
  'config/vitest.config.ts',
  'config/scripts/test-runtime/dom/vitest-dom-setup.ts',
  'config/scripts/test-runtime/dom/happy-dom-offscreen-canvas.ts',
  'config/scripts/test-runtime/dom/happy-dom-mutation-observer-retention.ts',
  'config/scripts/test-runtime/environment/vitest-host-ports-setup.ts',
  'config/scripts/test-runtime/environment/vitest-real-agent-home-write-guard.ts',
  'config/scripts/test-runtime/environment/vitest-real-agent-cli-guard.ts'
]
const NODE_SERVER_POLICY_TESTS = new Set([
  'config/scripts/node-server/qualification/node-server-change-scope.test.mjs'
])
const ALWAYS_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'config/pnpmfile.cjs',
  'tsconfig.json',
  '.github/workflows/node-server-tests.yml',
  'config/scripts/node-server/qualification/node-server-change-scope.mjs',
  'config/scripts/node-server/qualification/node-server-native-compat-scope.mjs',
  ...NODE_SERVER_POLICY_TESTS,
  'config/scripts/workspace/source-exports/workspace-source-exports.mjs',
  'config/scripts/workspace/source-exports/workspace-source-exports.test.mjs',
  'config/scripts/runtime-verification/headless-detector/headless-detector-compiler-cache.mjs',
  'config/scripts/native-build/windows/initialize-windows-native-toolchain.mjs',
  'config/scripts/native-build/windows/capture-windows-native-environment.cmd',
  'config/scripts/node-server/qualification/node-server-qualification.mjs',
  // The source graph sees process-host source, not the build that emits the dist servers load.
  'src/packages/process-host/.gitignore',
  'src/packages/process-host/scripts/build-dist.mjs',
  'src/packages/process-host/tsconfig.json'
])
const ALWAYS_PREFIXES = [
  '.github/actions/install-node-dependencies/',
  '.github/actions/restore-pnpm-verification/',
  '.github/actions/prepare-headless-compiler/',
  '.github/actions/prepare-native-runtime/',
  '.github/actions/prepare-orcad-prebuilds/',
  // These areas also contain worker paths and fixtures opened without an import.
  'src/main/persistence/',
  'src/main/sqlite/',
  'src/main/orcad/',
  'src/main/runtime/',
  'src/main/claude/',
  'src/main/daemon/pty-subprocess/conpty-startup-input-reader.ts',
  'src/main/daemon/pty-subprocess/daemon-pty-physical-owner.ts',
  'src/main/daemon/pty-subprocess/foreground-fallback-process.ts',
  'src/main/daemon/pty-subprocess/foreground-process-tracker.ts',
  'src/main/daemon/pty-subprocess/native-pty-spawn-windows.test.ts',
  'src/main/daemon/pty-subprocess/native-pty-spawn.ts',
  'src/main/daemon/pty-subprocess/pre-listener-events.ts',
  'src/main/daemon/pty-subprocess/pty-shell-foreground-confirmation.ts',
  'src/main/daemon/pty-subprocess/shell-launch-plan.ts',
  'src/main/daemon/pty-subprocess/spawn-environment.ts',
  'src/main/daemon/pty-subprocess/spawn-file-child-processes.ts',
  'src/main/daemon/pty-subprocess/spawn-file-foreground-process.ts',
  'src/main/daemon/pty-subprocess/spawn-file-foreground-rejected-agents.test.ts',
  'src/main/daemon/pty-subprocess/spawn-preflight.ts',
  'src/main/daemon/pty-subprocess/subprocess-handle.ts',
  'src/main/providers/',
  'config/patches/',
  'config/tsconfig',
  'native/',
  'resources/licenses/ripgrep/'
]

export function discoverNodeServerTests(root = ROOT) {
  const selectors = nodeServerTestPaths({ artifact: true, crossRuntime: true, template: true })
  return globSync(
    ['src/**/*.test.{ts,tsx}', 'config/scripts/**/*.test.{ts,mjs}', 'tests/e2e/**/*.unit.test.ts'],
    { cwd: root }
  )
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => selectors.some((selector) => file.includes(selector)))
    .sort()
}

export async function collectNodeServerInputs({ root = ROOT, entryPoints } = {}) {
  const [
    { build },
    {
      externalNativeAddons,
      ORCAD_CHILD_ENTRY_POINTS,
      ORCAD_ENTRY_POINT,
      ORCAD_LAUNCHER_ENTRY_POINT
    },
    { createWorkspaceSourceResolver }
  ] = await Promise.all([
    import('esbuild'),
    import('../../orcad-distribution/server-bundle/orcad-entry-build.mjs'),
    import('../../workspace/source-exports/workspace-source-exports.mjs')
  ])
  const workspace = createWorkspaceSourceResolver(root)
  const manifests = new Set()
  const workspaceSources = {
    name: 'workspace-source-exports',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^[^./]/ }, ({ path }) => {
        const source = workspace.resolve(path)
        if (!source) {
          return null
        }
        manifests.add(source.manifest)
        return { path: source.path }
      })
    }
  }
  const entries = entryPoints ?? [
    ORCAD_ENTRY_POINT,
    ORCAD_LAUNCHER_ENTRY_POINT,
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
    plugins: [workspaceSources, externalNativeAddons],
    metafile: true,
    logLevel: 'silent'
  })
  // esbuild parses every ancestor package.json; a checkout nested in another one must not fail on it.
  const warnings = result.warnings.filter(
    ({ location }) => !location || isInsideRoot(root, location.file)
  )
  if (warnings.length > 0) {
    throw new Error(warnings.map((warning) => warning.text).join('\n'))
  }
  return new Set([
    ...manifests,
    ...Object.keys(result.metafile.inputs).map((file) =>
      file.replaceAll('\\', '/').replace(/\?.*$/, '')
    )
  ])
}

function isInsideRoot(root, file) {
  const path = relative(root, resolve(root, file))
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

function isSourceUnitTest(file) {
  return (
    /^src\/(?:[^/]+\/)*[^/]+\.test\.(?:ts|tsx)$/.test(file) &&
    !file.includes('/../') &&
    !file.includes('/./')
  )
}

export async function classifyNodeServerChanges(
  changedFiles,
  collect = collectNodeServerInputs,
  { deferGraph = false, modifiedFiles } = {}
) {
  if (changedFiles.length === 0) {
    return { shouldRun: true, reason: 'No complete changed-file evidence' }
  }
  const modifiedOnly =
    Array.isArray(modifiedFiles) &&
    new Set(changedFiles).size === changedFiles.length &&
    new Set(modifiedFiles).size === modifiedFiles.length &&
    modifiedFiles.length === changedFiles.length &&
    changedFiles.every((file) => modifiedFiles.includes(file))
  const selectors = nodeServerTestPaths({ artifact: true, crossRuntime: true, template: true })
  const forced = changedFiles.find(
    (file) =>
      (ALWAYS_FILES.has(file) && !(modifiedOnly && NODE_SERVER_POLICY_TESTS.has(file))) ||
      (ALWAYS_PREFIXES.some((prefix) => file.startsWith(prefix)) && !isSourceUnitTest(file)) ||
      /^config\/scripts\/(?:release\/workflow-contracts\/|orcad-distribution\/qualification\/)?(?:orcad-distribution\/prebuilds\/|orcad-distribution\/template\/|orcad-distribution\/server-bundle\/|orcad-distribution\/qualification\/)?(?:test-runtime\/environment\/)?[^/]*orcad[^/]*$/.test(
        file
      ) ||
      selectors.some((selector) => file.includes(selector))
  )
  if (forced) {
    return { shouldRun: true, reason: `Build or CI input changed: ${forced}` }
  }
  if (deferGraph) {
    return { graphRequired: true, reason: 'Installed dependencies are needed to check imports' }
  }
  try {
    const inputs = await collect()
    const matchedFiles = changedFiles.filter((file) => inputs.has(file))
    const matched = matchedFiles[0]
    return {
      ...(modifiedOnly ? { graphResolved: true, matchedFiles } : {}),
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
  const modifiedArgument = process.argv.indexOf('--modified-paths')
  const modifiedFiles =
    modifiedArgument === -1
      ? undefined
      : readFileSync(process.argv[modifiedArgument + 1], 'utf8')
          .split('\0')
          .filter(Boolean)
  const result = await classifyNodeServerChanges(changedFiles, collectNodeServerInputs, {
    deferGraph: process.argv.includes('--defer-graph'),
    modifiedFiles
  })
  console.log(result.reason)
  const policy = nodeServerQualification(changedFiles, result, {
    fullQualification: process.argv.includes('--full-qualification')
  })
  const diffArgument = process.argv.indexOf('--diff-paths')
  const native = result.graphUnavailable
    ? { nativeCompatibility: true, reason: 'Server dependency graph unavailable' }
    : await classifyNativeCompatChanges(changedFiles, collectNodeServerInputs, {
        pullRequest: process.argv.includes('--pull-request'),
        fullQualification: process.argv.includes('--full-qualification'),
        rawDiff:
          diffArgument === -1 ? undefined : readFileSync(process.argv[diffArgument + 1], 'utf8'),
        deferGraph: process.argv.includes('--defer-graph')
      })
  console.log(native.reason)
  let output = result.graphRequired || native.graphRequired ? 'graph_required=true\n' : ''
  if (!result.graphRequired) {
    output += `should_run=${result.shouldRun}\nqualification=${policy.qualification}\nrunners=${JSON.stringify(policy.runners)}\n`
  }
  if (!native.graphRequired) {
    output += `native_compatibility=${native.nativeCompatibility}\n`
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, output)
  } else {
    process.stdout.write(output)
  }
}
