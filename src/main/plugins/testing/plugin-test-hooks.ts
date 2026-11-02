/**
 * Node module hooks for running a plugin's own tests in plain Node: `orca` and `orca/testing`
 * resolve to the files Orca ships beside this one, and plugin sources (.ts, .tsx, .mts, .jsx) are
 * transpiled and resolved exactly as Orca's build-less loader does, so a test runs the code Orca
 * runs. Bundled to resources/plugins/declarative/orca-test-hooks.mjs (see orca-test-register.mjs).
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { posix, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isPluginWorkerSourcePath } from '../../../shared/plugins/frames/plugin-frame-source-modules'
import { resolvePluginModuleSpecifier } from '../panels/plugin-frame-module-resolution'
import { formatPluginTranspileFailure } from '../panels/plugin-source-transpile-failure'
import { transpilePluginSource } from '../panels/plugin-source-transpiler'
import { pluginModuleCandidatePaths } from '../plugin-module-candidate-paths'
import { transformPluginSource } from '../plugin-source-sucrase-transform'
import {
  isOrcaSpecifier,
  pluginWorkerOrcaImportMessage
} from '../workers/plugin-worker-orca-import'

type ResolveResult = { url: string; shortCircuit?: boolean; format?: string }
type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>
type ResolveContext = { parentURL?: string }
type LoadResult = {
  format: string
  source?: string | ArrayBuffer | Uint8Array
  shortCircuit?: boolean
}
type NextLoad = (url: string, context: unknown) => Promise<LoadResult>

const ORCA_FILES: Record<string, string> = {
  orca: './orca-runtime.mjs',
  'orca/jsx-runtime': './orca-runtime.mjs',
  'orca/jsx-dev-runtime': './orca-runtime.mjs',
  'orca/testing': './orca-testing.mjs'
}
const SOURCE_EXTENSION = /\.(?:tsx?|mts|jsx)$/i
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/i
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i

/** The plugin folder under test; files outside it (and node_modules) load as Node loads them.
 *  Real path, because Node's module URLs are (macOS /var is /private/var). */
const pluginRoot = realpathSync(process.env.ORCA_PLUGIN_TEST_ROOT ?? process.cwd())

function pluginRelativePath(url: string): string | null {
  if (!url.startsWith('file:')) {
    return null
  }
  const path = relative(pluginRoot, fileURLToPath(url))
  if (path.startsWith('..') || path.split(sep).includes('node_modules')) {
    return null
  }
  return path.split(sep).join(posix.sep)
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile()

/** The manifest's worker `main`, as a file URL; null when the plugin has none. */
function workerEntryUrl(): string | null {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(`${pluginRoot}${sep}orca-plugin.json`, 'utf8')
    )
    const main =
      typeof manifest === 'object' && manifest !== null && 'main' in manifest ? manifest.main : null
    return typeof main === 'string'
      ? pathToFileURL(`${pluginRoot}${sep}${main.split(/[\\/]/).join(sep)}`).href
      : null
  } catch {
    return null
  }
}

/** The worker's module graph: its files load and resolve as Orca's worker host does, not as
 *  frame modules (Node resolution, packages allowed, `.ts`/`.mts` only, no `orca` at run time). */
const workerModules = new Set<string>()
const workerEntry = workerEntryUrl()
if (workerEntry) {
  workerModules.add(workerEntry)
}

async function resolveWorkerImport(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  if (isOrcaSpecifier(specifier)) {
    throw new Error(pluginWorkerOrcaImportMessage(specifier))
  }
  let result: ResolveResult
  try {
    result = await nextResolve(specifier, context)
  } catch (error) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      throw error
    }
    const target = new URL(specifier, context.parentURL)
    const found = pluginModuleCandidatePaths(target.pathname.replace(/\/$/, ''))
      .map((candidate) => Object.assign(new URL(target.href), { pathname: candidate }))
      .find((url) => pluginRelativePath(url.href) !== null && isFile(fileURLToPath(url)))
    if (!found) {
      throw error
    }
    result = { url: found.href, shortCircuit: true }
  }
  if (pluginRelativePath(result.url) !== null) {
    workerModules.add(result.url)
  }
  return result
}

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  const orcaFile = ORCA_FILES[specifier]
  if (orcaFile) {
    return { url: new URL(orcaFile, import.meta.url).href, shortCircuit: true }
  }
  if (context.parentURL && workerModules.has(context.parentURL)) {
    return resolveWorkerImport(specifier, context, nextResolve)
  }
  const parent = context.parentURL ? pluginRelativePath(context.parentURL) : null
  // Only a plugin's own module imports by Orca's rules; the entry point's parent is a folder.
  const from = parent !== null && SCRIPT_FILE.test(parent) ? parent : null
  const relativeImport = specifier.startsWith('.') || specifier.startsWith('/')
  // Tests may import any package Node can; plugin sources get Orca's rules, so a test fails where
  // Orca would refuse the import.
  if (from === null || specifier.startsWith('node:') || (TEST_FILE.test(from) && !relativeImport)) {
    return nextResolve(specifier, context)
  }
  const resolution = await resolvePluginModuleSpecifier(from, specifier, async (candidate) =>
    isFile(`${pluginRoot}${sep}${candidate.split(posix.sep).join(sep)}`)
  )
  if (resolution.kind === 'refuse') {
    throw new Error(`${from}: ${resolution.reason}`)
  }
  if (resolution.kind === 'keep') {
    return nextResolve(specifier, context)
  }
  const target = posix.join(posix.dirname(from), decodeURIComponent(resolution.specifier))
  return {
    url: pathToFileURL(`${pluginRoot}${sep}${target.split(posix.sep).join(sep)}`).href,
    shortCircuit: true
  }
}

export async function load(url: string, context: unknown, nextLoad: NextLoad): Promise<LoadResult> {
  const path = pluginRelativePath(url)
  if (path !== null && workerModules.has(url)) {
    // Why ESM: Orca's worker host loads `.ts` as a module whatever package.json says.
    return isPluginWorkerSourcePath(path)
      ? {
          format: 'module',
          source: transformPluginSource(path, await readFile(fileURLToPath(url), 'utf8')),
          shortCircuit: true
        }
      : nextLoad(url, context)
  }
  if (path === null || !SOURCE_EXTENSION.test(path)) {
    return nextLoad(url, context)
  }
  const transpiled = transpilePluginSource(path, await readFile(fileURLToPath(url), 'utf8'))
  if (!transpiled.ok) {
    throw new SyntaxError(formatPluginTranspileFailure(path, transpiled.message))
  }
  return { format: 'module', source: transpiled.code, shortCircuit: true }
}

/** The same transform, for a Vite plugin (`orca plugin test` with the plugin's own vitest). */
export function transformPluginSourceForTest(path: string, source: string): string {
  const transpiled = transpilePluginSource(path, source)
  if (!transpiled.ok) {
    throw new SyntaxError(formatPluginTranspileFailure(path, transpiled.message))
  }
  return transpiled.code
}
