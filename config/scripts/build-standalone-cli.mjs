#!/usr/bin/env node
/**
 * Bundle the client-only Orca CLI into one CommonJS file that runs on the
 * system Node (>= 22). The desktop CLI keeps its multi-file tsc output.
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')
const CLI_ENTRY = join(ROOT, 'src', 'cli', 'index.ts')
const HANDLER_STUB_MODULE = join(ROOT, 'src', 'cli', 'handlers', 'desktop-only-handler-stub.ts')
export const STANDALONE_CLI_OUT_DIR = join(ROOT, 'out', 'cli-standalone')
export const STANDALONE_CLI_BUNDLE_FILENAME = 'orca.cjs'
export const STANDALONE_CLI_PACKAGE_NAME = 'orca-cli'
export const STANDALONE_CLI_NODE_ENGINE = '>=22'

// Why: these handler groups reach profile SQLite, agent-hook mutators, and the
// keychain; the standalone CLI refuses them, so their graphs are swapped out.
export const DESKTOP_ONLY_HANDLER_MODULES = [
  { file: 'account.ts', group: 'account', exportName: 'ACCOUNT_HANDLERS' },
  { file: 'artifacts.ts', group: 'artifacts', exportName: 'ARTIFACT_HANDLERS' },
  { file: 'agent-hooks.ts', group: 'agent-hooks', exportName: 'AGENT_HOOK_HANDLERS' },
  { file: 'profile-state.ts', group: 'profile-state', exportName: 'PROFILE_STATE_HANDLERS' }
]

// ws optional native accelerators; ws falls back to pure JS when they are absent.
const ALLOWED_EXTERNAL_PACKAGES = new Set(['bufferutil', 'utf-8-validate'])
const FORBIDDEN_IMPORTS = new Set(['electron', 'node:sqlite', 'sqlite', 'bun:sqlite'])
const FORBIDDEN_INPUT_PATTERNS = [
  { pattern: /(^|\/)src\/main\/persistence\//, reason: 'desktop persistence' },
  { pattern: /(^|\/)src\/main\/sqlite\//, reason: 'SQLite adapter' },
  { pattern: /keychain/i, reason: 'keychain access' },
  { pattern: /(^|\/)node_modules\/electron\//, reason: 'Electron' }
]

function toPosix(path) {
  return path.replaceAll('\\', '/')
}

function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export function findStandaloneCliBundleViolations(metafile) {
  const violations = new Set()
  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    const normalized = toPosix(inputPath)
    for (const { pattern, reason } of FORBIDDEN_INPUT_PATTERNS) {
      if (pattern.test(normalized)) {
        violations.add(`${reason}: ${normalized}`)
      }
    }
    for (const dependency of input.imports) {
      if (FORBIDDEN_IMPORTS.has(dependency.path)) {
        violations.add(`forbidden import ${dependency.path} from ${normalized}`)
        continue
      }
      if (!dependency.external || isBuiltin(dependency.path)) {
        continue
      }
      if (!ALLOWED_EXTERNAL_PACKAGES.has(packageName(dependency.path))) {
        violations.add(`unbundled dependency ${dependency.path} from ${normalized}`)
      }
    }
  }
  return [...violations].sort()
}

function desktopOnlyHandlerStubPlugin() {
  const byFile = new Map(
    DESKTOP_ONLY_HANDLER_MODULES.map((entry) => [
      toPosix(join(ROOT, 'src', 'cli', 'handlers', entry.file)),
      entry
    ])
  )
  return {
    name: 'orca-desktop-only-handler-stub',
    setup(pluginBuild) {
      pluginBuild.onLoad(
        { filter: /[\\/]src[\\/]cli[\\/]handlers[\\/][^\\/]+\.ts$/ },
        async (args) => {
          const entry = byFile.get(toPosix(args.path))
          if (!entry) {
            return undefined
          }
          // Why: the manifest reads this export by name at runtime, so a rename must fail the build.
          const source = await readFile(args.path, 'utf8')
          if (!source.includes(`export const ${entry.exportName}`)) {
            throw new Error(`${entry.file} no longer exports ${entry.exportName}`)
          }
          return {
            contents: [
              `import { createDesktopOnlyHandlerStub } from ${JSON.stringify(toPosix(HANDLER_STUB_MODULE))}`,
              `export const ${entry.exportName} = createDesktopOnlyHandlerStub(${JSON.stringify(entry.group)})`
            ].join('\n'),
            loader: 'ts',
            resolveDir: join(ROOT, 'src', 'cli', 'handlers')
          }
        }
      )
    }
  }
}

export async function buildStandaloneCli({ outDir = STANDALONE_CLI_OUT_DIR, version } = {}) {
  const resolvedVersion = version ?? (await readSourceVersion())
  const outfile = join(outDir, STANDALONE_CLI_BUNDLE_FILENAME)
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [CLI_ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    metafile: true,
    legalComments: 'none',
    logLevel: 'warning',
    write: false,
    // Why: client-only mode is a property of this artifact, not of the caller's env,
    // so child processes that run the desktop `orca` are not forced client-only.
    define: { 'process.env.ORCA_CLI_STANDALONE': '"1"' },
    plugins: [desktopOnlyHandlerStubPlugin()]
  })
  const violations = findStandaloneCliBundleViolations(result.metafile)
  if (violations.length > 0) {
    throw new Error(
      `Standalone CLI bundle pulls in desktop-only code:\n  ${violations.join('\n  ')}`
    )
  }
  const [output] = result.outputFiles
  if (!output) {
    throw new Error('Standalone CLI bundle produced no output')
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(outfile, output.contents)
  // Why: cli-version.ts reads the manifest beside the bundle for --version.
  await writeFile(
    join(outDir, 'package.json'),
    `${JSON.stringify(createStandaloneCliManifest(resolvedVersion), null, 2)}\n`
  )
  return { outfile, metafile: result.metafile, version: resolvedVersion }
}

export function createStandaloneCliManifest(version) {
  return {
    name: STANDALONE_CLI_PACKAGE_NAME,
    version,
    description: 'Orca command-line client for a running Orca runtime',
    license: 'MIT',
    type: 'commonjs',
    bin: { orca: 'bin/orca' },
    main: STANDALONE_CLI_BUNDLE_FILENAME,
    engines: { node: STANDALONE_CLI_NODE_ENGINE },
    files: [STANDALONE_CLI_BUNDLE_FILENAME, 'bin/orca', 'LICENSE']
  }
}

async function readSourceVersion() {
  const override = process.env.ORCA_STANDALONE_CLI_VERSION?.trim()
  if (override) {
    return override
  }
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('package.json has no version to stamp into the standalone CLI')
  }
  return manifest.version
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildStandaloneCli()
    .then(({ outfile, version }) => {
      process.stdout.write(`Built standalone CLI ${version}: ${outfile}\n`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
