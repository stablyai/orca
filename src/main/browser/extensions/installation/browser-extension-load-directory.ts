import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../../../shared/file-write/windows-retry-file-operations'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import {
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE,
  BROWSER_EXTENSION_LEGACY_WORKER_WRAPPER_FILE,
  BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE,
  BROWSER_EXTENSION_ORIGINAL_WORKER_FILE,
  BROWSER_EXTENSION_WORKER_SHIM_FILE,
  BROWSER_EXTENSION_WORKER_TOKEN_FILE
} from '../../../../shared/browser/extensions/browser-extension-worker-api'
import {
  buildBrowserExtensionWorkerShimInjection,
  isBrowserExtensionWorkerWrapper,
  withBrowserExtensionModuleShimImport,
  type BrowserExtensionWorkerShimInjection
} from './browser-extension-worker-shim-injection'
import { withOrcaContentScript } from './browser-extension-content-script-manifest'
import {
  withPrivateFilesHiddenFromWebAccessibleResources,
  withStaticWebAccessibleResources
} from './browser-extension-web-accessible-resources'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { resolveInsideExtensionDirectory } from './browser-extension-manifest'
import { getBrowserExtensionWorkerToken } from '../api-runtime/browser-extension-worker-api-host'
import {
  readBrowserExtensionContentScript,
  readBrowserExtensionWorkerShim
} from '../api-runtime/browser-extension-worker-shim-source'

/**
 * Orca loads every extension from a folder it owns, so it can add its worker's shim loading, API shim
 * and token without touching the original: store installs in place, unpacked folders from a copy.
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

async function writeAtomically(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.orca-tmp`, content)
  await renameFileWithWindowsRetryAsync(`${path}.orca-tmp`, path)
}

// Why compare first: rewriting identical files would churn mtimes under a loaded extension.
async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== content) {
    await writeAtomically(path, content)
  }
}

/**
 * Runs Orca's shim before the extension's worker, which keeps its declared path. A package missing
 * its worker file still loads; the worker fails as it would without Orca.
 */
async function injectWorkerShim(
  directory: string,
  injection: BrowserExtensionWorkerShimInjection
): Promise<void> {
  const workerPath = requireInside(directory, injection.workerPath)
  const source = await readFile(workerPath).catch((error: unknown) => {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  })
  if (!source) {
    return
  }
  if (injection.type === 'module') {
    const injected = withBrowserExtensionModuleShimImport(source)
    return injected ? writeAtomically(workerPath, injected) : undefined
  }
  // Why the header decides: store folders are prepared in place on every run, so once the wrapper
  // holds the declared path, the moved file is the original and must never be replaced.
  if (!isBrowserExtensionWorkerWrapper(source)) {
    await writeAtomically(requireInside(directory, injection.movedWorkerPath), source)
  }
  if (!source.equals(Buffer.from(injection.wrapperSource))) {
    await writeAtomically(workerPath, injection.wrapperSource)
  }
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
  BROWSER_EXTENSION_ORIGINAL_WORKER_FILE,
  BROWSER_EXTENSION_LEGACY_WORKER_WRAPPER_FILE
])

/**
 * Refuses a package that already has a file where Orca writes its own, which would overwrite it.
 * Asks the file system rather than comparing names, so every spelling that aliases one counts.
 */
export async function refuseOrcaFileCollisions(
  directory: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const injection = buildBrowserExtensionWorkerShimInjection(manifest)
  // Why the legacy wrapper too: an older build (after a downgrade) would write over that file, and
  // the wrapper's downgrade guard could not tell a worker by that name from it.
  const workerFiles = injection
    ? [
        posix.join(
          posix.dirname(injection.workerPath),
          BROWSER_EXTENSION_LEGACY_WORKER_WRAPPER_FILE
        ),
        ...(injection.type === 'classic' ? [injection.movedWorkerPath] : [])
      ]
    : []
  for (const path of [...ORCA_ROOT_FILES, ...workerFiles]) {
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
  const injection = buildBrowserExtensionWorkerShimInjection(staticResources)
  const withContentScript = withOrcaContentScript(injection?.manifest ?? staticResources)
  await writeIfChanged(originalPath, originalText)
  let workerScripts = ''
  if (injection) {
    const shim = readBrowserExtensionWorkerShim()
    // Why only the classic wrapper: the module import never changes, and the manifest says which.
    workerScripts = `${shim}\n${injection.type === 'classic' ? injection.wrapperSource : ''}`
    await writeIfChanged(join(directory, BROWSER_EXTENSION_WORKER_SHIM_FILE), shim)
    await injectWorkerShim(directory, injection)
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
      withContentScript ?? injection?.manifest ?? staticResources,
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
    hasWorker: injection !== null,
    workerSignature: unpacked
      ? null
      : createHash('sha256').update(`${manifestText}\n${workerScripts}`).digest('hex')
  }
}

const pending = new Map<string, Promise<PreparedBrowserExtensionDirectory>>()
const preparedThisRun = new Map<string, PreparedBrowserExtensionDirectory>()

/**
 * A folder is prepared once per run (an Orca update, which brings a new shim, is a new run), so a
 * profile reopening later, or a second profile, reuses it. An unpacked copy is never rewritten
 * under a profile running it; `refresh` (Settings › Reload) prepares it again.
 */
export async function prepareBrowserExtensionDirectory(
  extension: BrowserExtensionLoadSource,
  options: { refresh?: boolean } = {}
): Promise<PreparedBrowserExtensionDirectory> {
  const key = resolve(extension.path)
  let running = pending.get(key)
  const prepared = preparedThisRun.get(key)
  // Why not while a preparation runs: a profile starting mid-Reload must load the finished copy.
  if (prepared && !options.refresh && !running) {
    return prepared
  }
  if (!running) {
    running = prepare(extension)
    pending.set(key, running)
  }
  try {
    const result = await running
    // Forgotten meanwhile (its folder was replaced): this result describes the old contents.
    if (pending.get(key) === running) {
      keepPrepared(key, result)
    }
    return result
  } finally {
    if (pending.get(key) === running) {
      pending.delete(key)
    }
  }
}

/** Folders are kept only while installed, so failed installs, updates and removals never pile up. */
function keepPrepared(key: string, result: PreparedBrowserExtensionDirectory): void {
  const installed = new Set(
    getBrowserExtensionInstallStore()
      .list()
      .map((extension) => resolve(extension.path))
  )
  for (const path of preparedThisRun.keys()) {
    if (!installed.has(path)) {
      preparedThisRun.delete(path)
    }
  }
  if (installed.has(key)) {
    preparedThisRun.set(key, result)
  }
}

/** A store version folder is about to be replaced on disk: prepare it afresh next time. */
export function forgetPreparedBrowserExtensionDirectory(path: string): void {
  const key = resolve(path)
  preparedThisRun.delete(key)
  pending.delete(key)
}
