import { posix } from 'node:path'
import {
  BROWSER_EXTENSION_API_SCHEME,
  BROWSER_EXTENSION_LEGACY_WORKER_WRAPPER_FILE,
  BROWSER_EXTENSION_ORIGINAL_WORKER_FILE,
  BROWSER_EXTENSION_WORKER_SHIM_FILE
} from '../../../../shared/browser/extensions/browser-extension-worker-api'
import { referencesParentDirectory } from './browser-extension-manifest'

type Manifest = Record<string, unknown>

/**
 * How Orca's API shim runs before the extension's worker, which keeps its declared path. A classic
 * worker's script moves aside for a wrapper that loads the shim, then it; a module worker imports
 * the shim from its own first line.
 */
export type BrowserExtensionWorkerShimInjection = {
  /** The manifest Orca loads: the worker keeps its own path; connect-src allows the API. */
  manifest: Manifest
  /** The declared worker script, relative to the extension root. */
  workerPath: string
} & ({ type: 'classic'; movedWorkerPath: string; wrapperSource: string } | { type: 'module' })

function asRecord(value: unknown): Manifest | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

const API_SOURCES = ["'self'", `${BROWSER_EXTENSION_API_SCHEME}:`]

/** Lets the worker reach Orca's API (and read its token) under a policy that limits connect-src. */
function withBrowserExtensionApiConnectSource(policy: string): string {
  const directives = policy
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
  const named = (name: string) =>
    directives.findIndex((directive) => directive.toLowerCase().split(/\s+/)[0] === name)
  const sourcesOf = (index: number) =>
    directives[index]
      .split(/\s+/)
      .slice(1)
      .filter((source) => source !== "'none'")
  const connect = named('connect-src')
  if (connect >= 0) {
    const sources = sourcesOf(connect)
    directives[connect] = [
      'connect-src',
      ...sources,
      ...API_SOURCES.filter((s) => !sources.includes(s))
    ].join(' ')
  } else {
    const fallback = named('default-src')
    if (fallback < 0) {
      return policy
    }
    const sources = sourcesOf(fallback)
    directives.push(
      ['connect-src', ...sources, ...API_SOURCES.filter((s) => !sources.includes(s))].join(' ')
    )
  }
  return directives.join('; ')
}

const SHIM_URL = JSON.stringify(`/${BROWSER_EXTENSION_WORKER_SHIM_FILE}`)
const MODULE_SHIM_IMPORT = `import ${SHIM_URL};`
const LEGACY_WRAPPER_PATTERN = `/\\/${BROWSER_EXTENSION_LEGACY_WORKER_WRAPPER_FILE.replaceAll('.', '\\.')}$/`
/** Starts every classic wrapper, and tells a later run it from the extension's script: never change it. */
const WRAPPER_HEADER = '// Written by Orca:'

/**
 * Returns null when there is no worker. Why the declared path: extensions read their worker's URL
 * (Keeper refuses to start unless location.href names its own script). Why a separate wrapper for
 * a classic worker: run inside its script, the shim would see the worker's own top-level bindings
 * (its `const Promise`, its `function fetch`) before they exist. A module's bindings are its own,
 * and its importers need the entry module's identity, so a module keeps its file.
 */
export function buildBrowserExtensionWorkerShimInjection(
  manifest: Manifest
): BrowserExtensionWorkerShimInjection | null {
  if (manifest.manifest_version !== 3) {
    throw new Error('Orca supports Manifest V3 extensions only')
  }
  const background = asRecord(manifest.background)
  const worker = background?.service_worker
  if (!background || typeof worker !== 'string' || !worker.trim()) {
    return null
  }
  const workerPath = posix.normalize(worker.trim().replace(/^\/+/, ''))
  if (referencesParentDirectory(workerPath)) {
    throw new Error('The background worker must be inside the extension folder')
  }
  const policy = asRecord(manifest.content_security_policy)
  const pagesPolicy = policy?.extension_pages
  // Why drop scripts: Firefox's event-page key; Chromium ignores it in MV3 but warns on every load.
  const { scripts: _firefoxScripts, ...chromiumBackground } = background
  const loaded = {
    manifest: {
      ...manifest,
      background: chromiumBackground,
      ...(policy && typeof pagesPolicy === 'string'
        ? {
            content_security_policy: {
              ...policy,
              extension_pages: withBrowserExtensionApiConnectSource(pagesPolicy)
            }
          }
        : {})
    },
    workerPath
  }
  if (background.type === 'module') {
    return { ...loaded, type: 'module' }
  }
  const movedWorkerPath = posix.join(
    posix.dirname(workerPath),
    BROWSER_EXTENSION_ORIGINAL_WORKER_FILE
  )
  const movedUrl = JSON.stringify(
    `/${movedWorkerPath.split('/').map(encodeURIComponent).join('/')}`
  )
  return {
    ...loaded,
    type: 'classic',
    movedWorkerPath,
    // Why the guard: under an older build's wrapper (after a downgrade) its shim already ran.
    wrapperSource: `${WRAPPER_HEADER} its chrome.* additions, then this extension's own worker.\nif (!${LEGACY_WRAPPER_PATTERN}.test(location.pathname)) importScripts(${SHIM_URL});\nimportScripts(${movedUrl});\n`
  }
}

/** Whether a worker file is Orca's classic wrapper rather than the extension's own script. */
export function isBrowserExtensionWorkerWrapper(source: Buffer): boolean {
  return source.subarray(0, WRAPPER_HEADER.length).toString('latin1') === WRAPPER_HEADER
}

/**
 * A module worker with the shim import first, or null when it is already there (store folders are
 * prepared in place on every run). Why after a hashbang: it is only valid as the very first line.
 */
export function withBrowserExtensionModuleShimImport(source: Buffer): Buffer | null {
  let at = source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0
  let load = MODULE_SHIM_IMPORT
  if (source.subarray(at, at + 2).toString('latin1') === '#!') {
    const ends = [source.indexOf(0x0a, at), source.indexOf(0x0d, at)].filter((end) => end !== -1)
    if (ends.length === 0) {
      at = source.length
      load = `\n${MODULE_SHIM_IMPORT}`
    } else {
      const end = Math.min(...ends)
      at = source[end] === 0x0d && source[end + 1] === 0x0a ? end + 2 : end + 1
    }
  }
  if (source.subarray(at, at + load.length).toString('latin1') === load) {
    return null
  }
  return Buffer.concat([source.subarray(0, at), Buffer.from(load), source.subarray(at)])
}
