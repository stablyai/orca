import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  resolvePluginModuleSpecifier,
  type PluginFileExists
} from './plugin-frame-module-resolution'
import {
  createPluginSourceTranspileClient,
  type PluginSourceTranspile
} from './plugin-source-transpile-client'
import {
  PLUGIN_SOURCE_TRANSPILER_ID,
  type PluginSourceTranspiled
} from './plugin-source-transpile-protocol'
import { parsePluginTranspileFailure } from './plugin-source-transpile-failure'
import { pluginSourceMapPrelude } from '../../../shared/plugins/frames/plugin-frame-source-map-prelude'

/** Source modules are read whole and transpiled per load, so they get a tighter cap. */
export const PLUGIN_SOURCE_MODULE_MAX_BYTES = 1024 * 1024
const CACHE_MAX_ENTRIES = 512
const CACHE_MAX_CHARS = 64 * 1024 * 1024

/** A module whose evaluation throws, so the error names the file (and line) in the guest and logs. */
export function pluginErrorModule(
  relativePath: string,
  message: string,
  at?: { line: number; column: number }
): string {
  const where = at ? `${relativePath}:${at.line}:${at.column}` : relativePath
  return `throw new Error(${JSON.stringify(`${where}: ${message}`)})\n`
}

/** 1-based line and column of `offset`; transpiling keeps lines, so the line is the source's. */
function locate(code: string, offset: number): { line: number; column: number } {
  const before = code.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  return { line: before.split('\n').length, column: offset - lineStart + 1 }
}

export type PluginSourceModuleCompiler = (input: {
  relativePath: string
  bytes: Uint8Array
  exists: PluginFileExists
}) => Promise<string>

/**
 * Turns a plugin's `.ts/.tsx/.mts/.jsx` file into the JavaScript module the guest runs: types and
 * JSX removed (lines are preserved, and an inline source map covers columns), and every relative
 * import pointed at an exact file. Transpiling runs off the main thread; results are cached here
 * by content, transpiler and options.
 */
export function createPluginSourceModuleCompiler(
  options: { transpile?: PluginSourceTranspile; transpilerId?: string } = {}
): PluginSourceModuleCompiler {
  let transpile = options.transpile
  const transpilerId = options.transpilerId ?? PLUGIN_SOURCE_TRANSPILER_ID
  const cache = new Map<string, { value: PluginSourceTranspiled; chars: number }>()
  let cachedChars = 0

  const remember = (key: string, value: PluginSourceTranspiled): PluginSourceTranspiled => {
    const chars = value.ok ? value.code.length + value.mappings.length : value.message.length
    cache.set(key, { value, chars })
    cachedChars += chars
    for (const [oldest, entry] of cache) {
      if (cache.size <= CACHE_MAX_ENTRIES && cachedChars <= CACHE_MAX_CHARS) {
        break
      }
      cache.delete(oldest)
      cachedChars -= entry.chars
    }
    return value
  }

  const transpileCached = async (
    relativePath: string,
    source: string
  ): Promise<PluginSourceTranspiled> => {
    const key = createHash('sha256')
      .update(JSON.stringify([transpilerId, relativePath, posix.extname(relativePath)]))
      .update('\0')
      .update(source)
      .digest('hex')
    const hit = cache.get(key)
    if (hit) {
      // Re-insert so the map's order stays least recently used first.
      cache.delete(key)
      cache.set(key, hit)
      return hit.value
    }
    // Why lazy: the worker starts only once a plugin frame loads a source module.
    transpile ??= createPluginSourceTranspileClient()
    return remember(key, await transpile(relativePath, source))
  }

  return async ({ relativePath, bytes, exists }) => {
    if (bytes.byteLength > PLUGIN_SOURCE_MODULE_MAX_BYTES) {
      return pluginErrorModule(
        relativePath,
        `is ${bytes.byteLength} bytes; source modules are capped at ${PLUGIN_SOURCE_MODULE_MAX_BYTES} bytes`
      )
    }
    const transpiled = await transpileCached(relativePath, Buffer.from(bytes).toString('utf8'))
    if (!transpiled.ok) {
      const failure = parsePluginTranspileFailure(relativePath, transpiled.message)
      return pluginErrorModule(relativePath, failure.message, failure.at)
    }
    let code = transpiled.code
    // Back to front, so earlier offsets stay valid as specifiers change length.
    for (const entry of transpiled.imports.toReversed()) {
      const resolution = await resolvePluginModuleSpecifier(relativePath, entry.specifier, exists)
      if (resolution.kind === 'refuse') {
        // Located at the specifier's opening quote.
        return pluginErrorModule(
          relativePath,
          resolution.reason,
          locate(code, Math.max(0, entry.start - 1))
        )
      }
      if (resolution.kind === 'rewrite') {
        const quoted = code[entry.start - 1] === '"' || code[entry.start - 1] === "'"
        const replacement = quoted ? resolution.specifier : JSON.stringify(resolution.specifier)
        code = code.slice(0, entry.start) + replacement + code.slice(entry.end)
      }
    }
    // A hashbang must stay first; such a module just keeps Chromium's transpiled columns.
    return code.startsWith('#!') ? code : pluginSourceMapPrelude(transpiled.mappings) + code
  }
}
