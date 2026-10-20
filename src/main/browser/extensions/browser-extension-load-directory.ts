import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import {
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE,
  BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE,
  BROWSER_EXTENSION_WORKER_SHIM_FILE,
  BROWSER_EXTENSION_WORKER_WRAPPER_FILE,
  BROWSER_EXTENSION_WORKER_TOKEN_FILE
} from '../../../shared/browser-extension-worker-api'
import { buildBrowserExtensionBackgroundWrapper } from './browser-extension-background-wrapper'
import { withOrcaContentScript } from './browser-extension-content-script-manifest'
import {
  withPrivateFilesHiddenFromWebAccessibleResources,
  withStaticWebAccessibleResources
} from './browser-extension-web-accessible-resources'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { resolveInsideExtensionDirectory } from './browser-extension-manifest'
import { getBrowserExtensionWorkerToken } from './browser-extension-worker-api-host'
import {
  readBrowserExtensionContentScript,
  readBrowserExtensionWorkerShim
} from './browser-extension-worker-shim-source'

/**
 * Orca loads every extension from a folder it owns, so it can add its worker wrapper, API shim and
 * token without touching the original: store installs in place, unpacked folders from a copy.
 */

export type BrowserExtensionLoadSource = Pick<InstalledBrowserExtension, 'source' | 'path'>

export type PreparedBrowserExtensionDirectory = {
  directory: string
  extensionId: string
  /** Changes whenever the worker's scripts change; null means re-register on every load. */
  workerSignature: string | null
  hasWorker: boolean
}

/** Chromium's id for a manifest key: the first 128 bits of SHA-256 over the key, as a–p. */
export function chromeExtensionIdFromKey(base64Key: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(base64Key.replace(/-----[^-]+-----|\s/g, ''), 'base64'))
    .digest('hex')
    .slice(0, 32)
  return [...digest].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('')
}

/**
 * Why a key for unpacked copies: Chromium derives a keyless id from the folder path, which is not
 * knowable before loading; this key fixes the id per source folder before the worker starts.
 */
function unpackedManifestKey(sourceDirectory: string): string {
  return createHash('sha256')
    .update(`orca-unpacked:${resolve(sourceDirectory)}`)
    .digest('base64')
}

function parseManifest(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest.json is not an object')
  }
  return Object.fromEntries(Object.entries(parsed))
}

// Why compare first: rewriting identical files would churn mtimes under a loaded extension.
async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === content) {
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.orca-tmp`, content)
  await rename(`${path}.orca-tmp`, path)
}

function requireInside(directory: string, relativePath: string): string {
  const target = resolveInsideExtensionDirectory(directory, relativePath)
  if (!target) {
    throw new Error('The background worker must be inside the extension folder')
  }
  return target
}

async function readOriginalManifest(
  directory: string
): Promise<{ originalText: string; original: Record<string, unknown> }> {
  const originalText =
    (await readFile(join(directory, BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE), 'utf8').catch(
      () => null
    )) ?? (await readFile(join(directory, 'manifest.json'), 'utf8'))
  return { originalText, original: parseManifest(originalText) }
}

function manifestKey(
  original: Record<string, unknown>,
  extension: BrowserExtensionLoadSource
): string {
  if (typeof original.key === 'string') {
    return original.key
  }
  if (extension.source === 'unpacked') {
    return unpackedManifestKey(extension.path)
  }
  throw new Error('Extension package has no key; install it again')
}

/** The id an unpacked folder will load under, read without copying or loading anything. */
export async function browserExtensionIdForUnpackedFolder(directory: string): Promise<string> {
  const { original } = await readOriginalManifest(directory)
  return chromeExtensionIdFromKey(manifestKey(original, { source: 'unpacked', path: directory }))
}

// Why: Orca writes these into the package; none of them is meant for web pages.
const ORCA_PRIVATE_FILES = [
  BROWSER_EXTENSION_WORKER_TOKEN_FILE,
  BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE
]
const ORCA_GENERATED_FILE_NAMES = new Set([
  ...ORCA_PRIVATE_FILES,
  BROWSER_EXTENSION_WORKER_SHIM_FILE,
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE,
  BROWSER_EXTENSION_WORKER_WRAPPER_FILE
])

// Why skip Orca's own files: they appear only after the first load, and listing them would change
// the manifest on the next launch and needlessly re-register the worker.
async function listPackageFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && !ORCA_GENERATED_FILE_NAMES.has(entry.name))
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
}

async function prepare(
  extension: BrowserExtensionLoadSource
): Promise<PreparedBrowserExtensionDirectory> {
  const unpacked = extension.source === 'unpacked'
  const directory = unpacked
    ? getBrowserExtensionInstallStore().unpackedCopyDirectory(extension.path)
    : extension.path
  if (unpacked) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    await cp(extension.path, directory, {
      recursive: true,
      dereference: true,
      filter: (source) => basename(source) !== '.git'
    })
  }
  const originalPath = join(directory, BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE)
  const { originalText, original } = await readOriginalManifest(directory)
  const key = manifestKey(original, extension)
  const extensionId = chromeExtensionIdFromKey(key)
  const adjusted = withPrivateFilesHiddenFromWebAccessibleResources(
    withStaticWebAccessibleResources({ ...original, key }),
    await listPackageFiles(directory),
    ORCA_PRIVATE_FILES
  )
  const wrapper = buildBrowserExtensionBackgroundWrapper(adjusted)
  const withContentScript = withOrcaContentScript(wrapper?.manifest ?? adjusted)
  const manifestText = JSON.stringify(withContentScript ?? wrapper?.manifest ?? adjusted, null, 2)
  await writeIfChanged(originalPath, originalText)
  let workerScripts = ''
  if (wrapper) {
    const shim = readBrowserExtensionWorkerShim()
    workerScripts = `${shim}\n${wrapper.wrapperSource}`
    await writeIfChanged(join(directory, BROWSER_EXTENSION_WORKER_SHIM_FILE), shim)
    await writeIfChanged(requireInside(directory, wrapper.wrapperPath), wrapper.wrapperSource)
    await writeIfChanged(
      join(directory, BROWSER_EXTENSION_WORKER_TOKEN_FILE),
      JSON.stringify({ token: getBrowserExtensionWorkerToken(extensionId) })
    )
  }
  if (withContentScript) {
    await writeIfChanged(
      join(directory, BROWSER_EXTENSION_CONTENT_SCRIPT_FILE),
      readBrowserExtensionContentScript()
    )
  }
  await writeIfChanged(join(directory, 'manifest.json'), manifestText)
  return {
    directory,
    extensionId,
    hasWorker: wrapper !== null,
    workerSignature: unpacked
      ? null
      : createHash('sha256').update(`${manifestText}\n${workerScripts}`).digest('hex')
  }
}

const pending = new Map<string, Promise<PreparedBrowserExtensionDirectory>>()
const copiedThisRun = new Map<string, PreparedBrowserExtensionDirectory>()

/**
 * Store folders are re-checked on every load (an Orca update brings a new shim). An unpacked
 * folder is copied once per run, so a second profile never rewrites a copy another profile runs;
 * `refresh` (Settings › Reload) copies it again.
 */
export async function prepareBrowserExtensionDirectory(
  extension: BrowserExtensionLoadSource,
  options: { refresh?: boolean } = {}
): Promise<PreparedBrowserExtensionDirectory> {
  const key = resolve(extension.path)
  const copied = copiedThisRun.get(key)
  if (copied && !options.refresh) {
    return copied
  }
  let running = pending.get(key)
  if (!running) {
    running = prepare(extension)
    pending.set(key, running)
  }
  try {
    const prepared = await running
    if (extension.source === 'unpacked') {
      copiedThisRun.set(key, prepared)
    }
    return prepared
  } finally {
    if (pending.get(key) === running) {
      pending.delete(key)
    }
  }
}
