import { writeBrowserExtensionGeneratedFile } from './browser-extension-generated-files'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { browserExtensionPrivateResources } from './browser-extension-resource-privacy'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import {
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE,
  BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE,
  BROWSER_EXTENSION_WORKER_SHIM_FILE,
  BROWSER_EXTENSION_WORKER_WRAPPER_FILE,
  BROWSER_EXTENSION_WORKER_TOKEN_FILE
} from '../../../../shared/browser/extensions/browser-extension-worker-api'
import { buildBrowserExtensionBackgroundWrapper } from './browser-extension-background-wrapper'
import { withOrcaContentScript } from './browser-extension-content-script-manifest'
import { withPrivateFilesHiddenFromWebAccessibleResources } from './browser-extension-web-accessible-resources'
import { resolveInsideExtensionDirectory } from './browser-extension-manifest'
import type { BrowserExtensionExecution } from '../api-runtime/browser-extension-execution-authority'
import {
  acquireBrowserExtensionPackageRevision,
  getCurrentBrowserExtensionPackageRevision,
  materializeBrowserExtensionExecution
} from './browser-extension-package-revisions'
import {
  readBrowserExtensionContentScript,
  readBrowserExtensionWorkerShim
} from '../api-runtime/browser-extension-worker-shim-source'

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
  release: () => Promise<void>
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

async function revisionFor(
  extension: BrowserExtensionLoadSource,
  extensionId: string,
  refresh = false
) {
  const current = getCurrentBrowserExtensionPackageRevision(extension.path)
  if (current && !refresh) {
    return current
  }
  const { original } = await readOriginalManifest(extension.path, extension.source)
  if (extension.source === 'unpacked') {
    await refuseOrcaFileCollisions(extension.path, original)
  }
  const key = manifestKey(original, extension)
  if (chromeExtensionIdFromKey(key) !== extensionId) {
    throw new Error('Extension id changed since it was added; remove it and add it again')
  }
  return acquireBrowserExtensionPackageRevision(
    { id: extensionId, path: extension.path },
    JSON.stringify({ ...original, key }),
    ORCA_GENERATED_FILE_NAMES,
    refresh
  )
}

export async function refreshBrowserExtensionPackage(
  extension: BrowserExtensionLoadSource & { id: string }
): Promise<void> {
  await revisionFor(extension, extension.id, true)
}

/** Original assets are immutable and shared; authority-bearing resources belong to this execution. */
export async function prepareBrowserExtensionDirectory(
  extension: BrowserExtensionLoadSource,
  execution: BrowserExtensionExecution,
  options: { refresh?: boolean } = {}
): Promise<PreparedBrowserExtensionDirectory> {
  execution.controller.signal.throwIfAborted()
  const revision = await revisionFor(extension, execution.extensionId, options.refresh)
  if (revision.extensionId !== execution.extensionId) {
    throw new Error('Extension id changed since it was added; remove it and add it again')
  }
  const materialized = await materializeBrowserExtensionExecution(
    revision,
    execution.controller.signal
  )
  const directory = materialized.directory
  try {
    execution.controller.signal.throwIfAborted()
    const originalText = revision.originalManifest
    const staticResources = revision.manifest
    const shimFile = `orca-extension-api-${execution.fileNonce}.js`
    const tokenFile = `orca-extension-api-token-${execution.fileNonce}.json`
    const wrapper = buildBrowserExtensionBackgroundWrapper(staticResources, {
      shim: shimFile,
      wrapper: `orca-background-${execution.fileNonce}.js`
    })
    const manifest =
      withOrcaContentScript(wrapper?.manifest ?? staticResources, execution.contentScriptFile) ??
      wrapper?.manifest ??
      staticResources
    await writeBrowserExtensionGeneratedFile(
      join(directory, BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE),
      originalText
    )
    if (wrapper) {
      await writeBrowserExtensionGeneratedFile(
        join(directory, shimFile),
        readBrowserExtensionWorkerShim()
          .replaceAll(BROWSER_EXTENSION_WORKER_TOKEN_FILE, tokenFile)
          .replaceAll('ORCA_EXTENSION_OWN_PREFIX', execution.contentScriptFile)
          .replaceAll('ORCA_EXTENSION_OWN_EXECUTION', execution.fileNonce)
      )
      await writeBrowserExtensionGeneratedFile(
        requireInside(directory, wrapper.wrapperPath),
        wrapper.wrapperSource
      )
      await writeBrowserExtensionGeneratedFile(
        join(directory, tokenFile),
        JSON.stringify({ token: execution.workerToken })
      )
    }
    await writeBrowserExtensionGeneratedFile(
      join(directory, execution.contentScriptFile),
      `${readBrowserExtensionContentScript().replaceAll(
        'ORCA_EXTENSION_CONTENT_BOOTSTRAP',
        execution.bootstrap
      )};\n({orcaPrefix:"initialized"});\n`
    )
    const privateResources = await browserExtensionPrivateResources(
      directory,
      manifest,
      [BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE, tokenFile, execution.contentScriptFile],
      execution.controller.signal
    )
    const manifestText = JSON.stringify(
      withPrivateFilesHiddenFromWebAccessibleResources(manifest, revision.files, (resource) =>
        privateResources.has(resource)
      ),
      null,
      2
    )
    await writeBrowserExtensionGeneratedFile(join(directory, 'manifest.json'), manifestText)
    execution.controller.signal.throwIfAborted()
    execution.preparedDirectory = directory
    execution.release = materialized.release
    return {
      directory,
      extensionId: revision.extensionId,
      hasWorker: wrapper !== null,
      workerSignature: null,
      release: materialized.release
    }
  } catch (error) {
    await materialized.release()
    throw error
  }
}
