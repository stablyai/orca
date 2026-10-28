import { posix } from 'node:path'
import {
  BROWSER_EXTENSION_API_SCHEME,
  BROWSER_EXTENSION_WORKER_SHIM_FILE,
  BROWSER_EXTENSION_WORKER_WRAPPER_FILE
} from '../../../shared/browser-extension-worker-api'

type Manifest = Record<string, unknown>

export type BrowserExtensionBackgroundWrapper = {
  /** The manifest Orca loads: background points at the wrapper, connect-src allows the API. */
  manifest: Manifest
  /** Relative to the extension root. */
  wrapperPath: string
  wrapperSource: string
}

function asRecord(value: unknown): Manifest | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

const API_SOURCES = ["'self'", `${BROWSER_EXTENSION_API_SCHEME}:`]

/** Lets the worker reach Orca's API (and read its token) under a policy that limits connect-src. */
export function withBrowserExtensionApiConnectSource(policy: string): string {
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

/**
 * Points the extension's background worker at an Orca wrapper that loads Orca's API shim first,
 * then the extension's own script, untouched. Returns null when there is no worker to wrap.
 * Why beside the original: relative importScripts in a classic worker resolve against the
 * worker's own URL, so the wrapper must live in the same folder.
 */
export function buildBrowserExtensionBackgroundWrapper(
  manifest: Manifest
): BrowserExtensionBackgroundWrapper | null {
  if (manifest.manifest_version !== 3) {
    throw new Error('Orca supports Manifest V3 extensions only')
  }
  const background = asRecord(manifest.background)
  const worker = background?.service_worker
  if (!background || typeof worker !== 'string' || !worker.trim()) {
    return null
  }
  const original = posix.normalize(worker.trim().replace(/^\/+/, ''))
  if (original.startsWith('..')) {
    throw new Error('The background worker must be inside the extension folder')
  }
  const folder = posix.dirname(original)
  const wrapperPath =
    folder === '.'
      ? BROWSER_EXTENSION_WORKER_WRAPPER_FILE
      : `${folder}/${BROWSER_EXTENSION_WORKER_WRAPPER_FILE}`
  const shimUrl = JSON.stringify(`/${BROWSER_EXTENSION_WORKER_SHIM_FILE}`)
  const originalUrl = JSON.stringify(`/${original.split('/').map(encodeURIComponent).join('/')}`)
  const load =
    background.type === 'module'
      ? `import ${shimUrl};\nimport ${originalUrl};\n`
      : `importScripts(${shimUrl}, ${originalUrl});\n`
  const policy = asRecord(manifest.content_security_policy)
  const pagesPolicy = policy?.extension_pages
  // Why drop scripts: Firefox's event-page key; Chromium ignores it in MV3 but warns on every load.
  const { scripts: _firefoxScripts, ...chromiumBackground } = background
  return {
    manifest: {
      ...manifest,
      background: { ...chromiumBackground, service_worker: wrapperPath },
      ...(policy && typeof pagesPolicy === 'string'
        ? {
            content_security_policy: {
              ...policy,
              extension_pages: withBrowserExtensionApiConnectSource(pagesPolicy)
            }
          }
        : {})
    },
    wrapperPath,
    wrapperSource: `// Written by Orca: its chrome.* additions, then this extension's own worker.\n${load}`
  }
}
