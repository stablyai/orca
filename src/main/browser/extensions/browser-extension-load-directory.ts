import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

/**
 * Why the store backup can be trusted: staging writes it from the manifest the install prompt
 * showed. An unpacked copy is made fresh for every prepare, so its own manifest is the original.
 */
async function readOriginalManifest(
  directory: string,
  source: BrowserExtensionLoadSource['source']
): Promise<{ originalText: string; original: Record<string, unknown> }> {
  const backup =
    source === 'webstore'
      ? await readFile(join(directory, BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE), 'utf8').catch(
          () => null
        )
      : null
  const originalText = backup ?? (await readFile(join(directory, 'manifest.json'), 'utf8'))
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
  const original = parseManifest(await readFile(join(directory, 'manifest.json'), 'utf8'))
  return chromeExtensionIdFromKey(manifestKey(original, { source: 'unpacked', path: directory }))
}

// Why: Orca writes these into the package; none of them is meant for web pages.
const ORCA_PRIVATE_FILES = [
  BROWSER_EXTENSION_WORKER_TOKEN_FILE,
  BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE
]
const ORCA_ROOT_FILES = [
  ...ORCA_PRIVATE_FILES,
  BROWSER_EXTENSION_WORKER_SHIM_FILE,
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE
]
const ORCA_GENERATED_FILE_NAMES = new Set([
  ...ORCA_ROOT_FILES,
  BROWSER_EXTENSION_WORKER_WRAPPER_FILE
])

/**
 * Refuses a package that already has a file where Orca writes its own, which would overwrite it.
 * Asks the file system rather than comparing names, so every spelling that aliases one counts.
 */
export async function refuseOrcaFileCollisions(
  directory: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const wrapperPath = buildBrowserExtensionBackgroundWrapper(manifest)?.wrapperPath
  for (const path of wrapperPath ? [...ORCA_ROOT_FILES, wrapperPath] : ORCA_ROOT_FILES) {
    const target = resolveInsideExtensionDirectory(directory, path)
    if (target && (await stat(target).catch(() => null))) {
      throw new Error(`Orca can't load this extension: its file ${path} uses a name Orca reserves`)
    }
  }
}

function fileIdentity(path: string): string | null {
  try {
    const stats = statSync(path, { bigint: true })
    return `${stats.dev}:${stats.ino}`
  } catch {
    return null
  }
}

/** True for a resource that is one of Orca's private files on disk, whatever its spelling. */
function isPrivateFileOnDisk(directory: string): (resource: string) => boolean {
  const privateIds = new Set(ORCA_PRIVATE_FILES.map((file) => fileIdentity(join(directory, file))))
  privateIds.delete(null)
  return (resource) => {
    const target = resolveInsideExtensionDirectory(directory, resource)
    return target !== null && privateIds.has(fileIdentity(target))
  }
}

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
  const { originalText, original } = await readOriginalManifest(directory, extension.source)
  if (unpacked) {
    await refuseOrcaFileCollisions(directory, original)
  }
  const key = manifestKey(original, extension)
  const extensionId = chromeExtensionIdFromKey(key)
  const packageFiles = await listPackageFiles(directory)
  const staticResources = withStaticWebAccessibleResources({ ...original, key })
  const wrapper = buildBrowserExtensionBackgroundWrapper(staticResources)
  const withContentScript = withOrcaContentScript(wrapper?.manifest ?? staticResources)
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
  // Why after writing them: privacy is decided by the private files' identity on disk.
  const manifestText = JSON.stringify(
    withPrivateFilesHiddenFromWebAccessibleResources(
      withContentScript ?? wrapper?.manifest ?? staticResources,
      packageFiles,
      isPrivateFileOnDisk(directory)
    ),
    null,
    2
  )
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
