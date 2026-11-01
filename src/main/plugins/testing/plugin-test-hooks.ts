/**
 * Node module hooks for running a plugin's own tests in plain Node: `orca` and `orca/testing`
 * resolve to the files Orca ships beside this one, and plugin sources (.ts, .tsx, .mts, .jsx) are
 * transpiled and resolved exactly as Orca's build-less loader does, so a test runs the code Orca
 * runs. Bundled to resources/plugins/declarative/orca-test-hooks.mjs (see orca-test-register.mjs).
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { posix, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolvePluginModuleSpecifier } from '../panels/plugin-frame-module-resolution'
import { transpilePluginSource } from '../panels/plugin-source-transpiler'

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

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  const orcaFile = ORCA_FILES[specifier]
  if (orcaFile) {
    return { url: new URL(orcaFile, import.meta.url).href, shortCircuit: true }
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
  if (path === null || !SOURCE_EXTENSION.test(path)) {
    return nextLoad(url, context)
  }
  const transpiled = transpilePluginSource(path, await readFile(fileURLToPath(url), 'utf8'))
  if (!transpiled.ok) {
    throw new SyntaxError(`${path}: ${transpiled.message}`)
  }
  return { format: 'module', source: transpiled.code, shortCircuit: true }
}

/** The same transform, for a Vite plugin (`orca plugin test` with the plugin's own vitest). */
export function transformPluginSourceForTest(path: string, source: string): string {
  const transpiled = transpilePluginSource(path, source)
  if (!transpiled.ok) {
    throw new SyntaxError(`${path}: ${transpiled.message}`)
  }
  return transpiled.code
}
