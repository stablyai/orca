import { readFileSync, realpathSync, statSync } from 'node:fs'
import {
  registerHooks,
  setSourceMapsSupport,
  type LoadHookSync,
  type ResolveHookSync
} from 'node:module'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPluginWorkerSourcePath } from '../../../shared/plugins/frames/plugin-frame-source-modules'
import { pluginModuleCandidatePaths } from '../plugin-module-candidate-paths'
import { transformPluginSource } from '../plugin-source-sucrase-transform'
import { isOrcaSpecifier, pluginWorkerOrcaImportMessage } from './plugin-worker-orca-import'

// Plain-Node entry code: runs in the plugin host process, so no Electron imports.

const NOT_FOUND_CODES: ReadonlySet<unknown> = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT'
])

export type PluginWorkerSourceHooks = { resolve: ResolveHookSync; load: LoadHookSync }

const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../')

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function isFile(url: URL): boolean {
  try {
    return statSync(fileURLToPath(url)).isFile()
  } catch {
    return false
  }
}

/**
 * Node resolution and loading for one plugin's worker, plus what frames already get: `.ts`/`.mts`
 * transpiled with sucrase and TypeScript-style relative imports (`./util`, `./util.js` for
 * `util.ts`). Only files under `pluginRoot` are affected; everything Node resolves on its own
 * (builtins, packages, exact paths) resolves exactly as it does for a JavaScript worker.
 */
export function createPluginWorkerSourceHooks(pluginRoot: string): PluginWorkerSourceHooks {
  // Why both: Node's resolver reports real paths, and a root may sit behind a symlink (macOS /var).
  const roots = [...new Set([resolve(pluginRoot), realpathOrSelf(resolve(pluginRoot))])]
  const rootOf = (path: string): string | undefined =>
    roots.find((root) => path === root || path.startsWith(root + sep))
  const fileUrlInsideRoot = (url: string | undefined): string | null => {
    if (!url?.startsWith('file:')) {
      return null
    }
    const path = fileURLToPath(url)
    return rootOf(path) === undefined ? null : path
  }

  const resolveHook: ResolveHookSync = (specifier, context, nextResolve) => {
    const parentURL = context.parentURL
    if (parentURL === undefined || fileUrlInsideRoot(parentURL) === null) {
      return nextResolve(specifier, context)
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (isOrcaSpecifier(specifier)) {
        throw new Error(pluginWorkerOrcaImportMessage(specifier), { cause: error })
      }
      if (!isRelativeSpecifier(specifier) || !NOT_FOUND_CODES.has(errorCode(error))) {
        throw error
      }
      const target = new URL(specifier, parentURL)
      // Encoded pathnames are `/`-separated on every platform, and extensions are plain ASCII.
      for (const candidate of pluginModuleCandidatePaths(target.pathname.replace(/\/$/, ''))) {
        const url = new URL(target.href)
        url.pathname = candidate
        if (fileUrlInsideRoot(url.href) !== null && isFile(url)) {
          return { url: url.href, shortCircuit: true }
        }
      }
      throw error
    }
  }

  const loadHook: LoadHookSync = (url, context, nextLoad) => {
    const path = fileUrlInsideRoot(url)
    // Why no .tsx: a worker has no DOM, so JSX is left to Node, which refuses it.
    if (path === null || !isPluginWorkerSourcePath(path)) {
      return nextLoad(url, context)
    }
    // Why read here: these are the bytes on disk the reviewed-content hash covered, never a cache.
    const source = readFileSync(path, 'utf8')
    const relativePath = relative(rootOf(path) ?? '', path)
      .split(sep)
      .join('/')
    try {
      // Why always ESM: frames treat `.ts` as a module too, whatever package.json says.
      return {
        format: 'module',
        source: transformPluginSource(relativePath, source),
        shortCircuit: true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`cannot transpile ${relativePath}: ${message}`, { cause: error })
    }
  }

  return { resolve: resolveHook, load: loadHook }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Installs the hooks for this host process's one plugin; stack traces map back to `.ts` lines. */
export function registerPluginWorkerSourceHooks(pluginRoot: string): void {
  setSourceMapsSupport(true)
  registerHooks(createPluginWorkerSourceHooks(pluginRoot))
}
