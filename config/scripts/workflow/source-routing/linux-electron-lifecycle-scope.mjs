import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createWorkspaceSourceResolver } from '../../workspace/source-exports/workspace-source-exports.mjs'
import { LINUX_PACKAGE_TESTS } from './pr-package-test-paths.mjs'

export const LINUX_ELECTRON_LIFECYCLE_TESTS = LINUX_PACKAGE_TESTS.filter((file) =>
  file.endsWith('.electron.test.ts')
)

// Inputs every fixture bundle or the step itself consumes outside the import graph.
const FORCE_PREFIXES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'electron.vite.config.ts',
  'config/tsconfig',
  'config/vitest',
  'config/scripts/test-runtime/',
  'config/scripts/workspace/source-exports/',
  '.github/workflows/pr.yml',
  '.github/workflows/linux-electron-lifecycle.yml',
  '.github/actions/install-node-dependencies/',
  '.github/actions/prepare-native-runtime/',
  'config/scripts/workflow/source-routing/linux-electron-lifecycle-scope',
  'config/scripts/workflow/source-routing/pr-package-test-paths'
]

const REPO_PATH_LITERAL = /['"`]((?:src|config|resources)\/[\w./@-]+\.[a-z]+)['"`]/g
const ALIASES = [
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]

async function bundleInputs(root, entries, workspace) {
  const manifests = new Set()
  const result = await build({
    entryPoints: entries.map((entry) => path.join(root, entry)),
    bundle: true,
    write: false,
    outdir: path.join(root, 'linux-electron-lifecycle-scope-metafile-only'),
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    absWorkingDir: root,
    logLevel: 'silent',
    loader: { '.html': 'text', '.css': 'text', '.svg': 'text', '.png': 'file' },
    plugins: [
      {
        name: 'linux-electron-lifecycle-sources',
        setup(pluginBuild) {
          // Vite asset queries load the same file; keep the file as an input.
          pluginBuild.onResolve({ filter: /\?/ }, ({ path: specifier, resolveDir }) => ({
            path: path.resolve(resolveDir, specifier.replace(/\?.*$/, '')),
            namespace: 'asset'
          }))
          pluginBuild.onLoad({ filter: /.*/, namespace: 'asset' }, ({ path: file }) => ({
            contents: '',
            loader: 'js',
            watchFiles: [file]
          }))
          pluginBuild.onResolve({ filter: /^@(?:orca|renderer)?\// }, async (args) => {
            const source = workspace.resolve(args.path)
            if (source) {
              // The manifest's orca-source export decides which file loads.
              manifests.add(source.manifest)
              return { path: source.path }
            }
            const alias = ALIASES.find(([prefix]) => args.path.startsWith(prefix))
            if (!alias) {
              return undefined
            }
            return pluginBuild.resolve(`./${alias[1]}${args.path.slice(alias[0].length)}`, {
              resolveDir: root,
              kind: args.kind
            })
          })
        }
      }
    ]
  })
  const relative = (file) =>
    path
      .relative(root, path.resolve(root, file.replace(/^asset:/, '')))
      .split(path.sep)
      .join('/')
  return [...Object.keys(result.metafile.inputs).map(relative), ...manifests]
}

/** Repo files the Electron lifecycle tests and the fixtures they bundle at runtime load. */
export async function collectLinuxElectronLifecycleInputs(root = process.cwd()) {
  const workspace = createWorkspaceSourceResolver(root)
  const inputs = new Set()
  let entries = [...LINUX_ELECTRON_LIFECYCLE_TESTS]
  // Fixtures name their bundle entries as repo-path strings; follow them to a fixpoint.
  while (entries.length) {
    for (const entry of entries) {
      inputs.add(entry)
    }
    const code = entries.filter((entry) => /\.[cm]?[jt]sx?$/.test(entry))
    const bundled = code.length ? await bundleInputs(root, code, workspace) : []
    const next = new Set()
    for (const file of bundled) {
      inputs.add(file)
    }
    for (const file of inputs) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || !existsSync(path.join(root, file))) {
        continue
      }
      for (const [, literal] of readFileSync(path.join(root, file), 'utf8').matchAll(
        REPO_PATH_LITERAL
      )) {
        const target = path.join(root, literal)
        if (inputs.has(literal)) {
          continue
        }
        if (!existsSync(target)) {
          // A deleted fixture the tests still name must select the step.
          inputs.add(literal)
        } else if (statSync(target).isFile()) {
          next.add(literal)
        }
      }
    }
    entries = [...next]
  }
  return inputs
}

export function linuxElectronLifecycleScope(changedFiles, inputs) {
  if (!changedFiles.length) {
    return { run: true, reason: 'Missing changed-path evidence' }
  }
  const forced = changedFiles.find((file) =>
    FORCE_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))
  )
  if (forced) {
    return { run: true, reason: `Shared input changed: ${forced}` }
  }
  // Fixtures may read non-code assets beside their sources by relative path.
  const inputDirs = new Set([...inputs].map((file) => path.posix.dirname(file)))
  const hit = changedFiles.find(
    (file) =>
      inputs.has(file) || (!/\.[cm]?[jt]sx?$/.test(file) && inputDirs.has(path.posix.dirname(file)))
  )
  return hit
    ? { run: true, reason: `Lifecycle input changed: ${hit}` }
    : { run: false, reason: 'No Electron lifecycle test input changed' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--list')) {
    process.stdout.write(`${LINUX_ELECTRON_LIFECYCLE_TESTS.join('\n')}\n`)
  } else {
    let input = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      input += chunk
    }
    const changed = input.split(/\r?\n/).filter(Boolean)
    const scope = linuxElectronLifecycleScope(changed, await collectLinuxElectronLifecycleInputs())
    console.error(scope.reason)
    process.stdout.write(`run=${scope.run}\n`)
  }
}
