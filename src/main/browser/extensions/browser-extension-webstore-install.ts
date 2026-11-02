import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE } from '../../../shared/browser-extension-worker-api'
import { browserSessionRegistry } from '../browser-session-registry'
import {
  readBrowserExtensionArchive,
  writeBrowserExtensionArchive
} from './browser-extension-archive'
import type { VerifiedCrx } from './browser-extension-crx'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { refuseOrcaFileCollisions } from './browser-extension-load-directory'
import {
  readBrowserExtensionManifest,
  type BrowserExtensionManifestSummary
} from './browser-extension-manifest'
import {
  summarizeManifestPermissions,
  type BrowserExtensionPermissionSummary
} from './browser-extension-permission-summary'
import {
  forgetHeldBrowserExtensionUpdate,
  getHeldBrowserExtensionUpdate
} from './browser-extension-held-updates'
import { notifyBrowserExtensionListChanged } from './browser-extension-list-changes'
import { withExtensionEnabled } from './browser-extension-profile-enablement'
import { reloadBrowserExtensionWhereEnabled } from './browser-extension-profile-reload'
import {
  loadBrowserExtensionIntoProfile,
  unloadBrowserExtensionEverywhere
} from './browser-extension-session-loader'

/**
 * The one install path for store extensions: the store page, Settings and updates all stage a
 * verified CRX here, then commit it side by side with any installed version.
 */

const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/
const STAGING_PREFIX = '.staging-'
const busyExtensionIds = new Set<string>()

export class BrowserExtensionBusyError extends Error {
  constructor() {
    super('This extension is already being installed or removed')
  }
}

/** Serializes install, update and uninstall of one extension id. */
export async function withBrowserExtensionLock<T>(
  extensionId: string,
  action: () => Promise<T>
): Promise<T> {
  if (busyExtensionIds.has(extensionId)) {
    throw new BrowserExtensionBusyError()
  }
  busyExtensionIds.add(extensionId)
  try {
    return await action()
  } finally {
    busyExtensionIds.delete(extensionId)
  }
}

export function isBrowserExtensionBusy(extensionId: string): boolean {
  return busyExtensionIds.has(extensionId)
}

export type StagedWebStoreExtension = {
  extensionId: string
  version: string
  /** Temporary folder under `<root>/<id>/` until commit renames it to `<version>/`. */
  directory: string
  summary: BrowserExtensionManifestSummary
  access: BrowserExtensionPermissionSummary
}

function parseManifest(data: Uint8Array): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(data).toString('utf8').replace(/^﻿/, ''))
  } catch {
    throw new Error('Extension package has an unreadable manifest')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Extension package has an unreadable manifest')
  }
  const manifest = Object.fromEntries(Object.entries(parsed))
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    throw new Error('Extension package has an invalid version')
  }
  return manifest
}

/** Unpacks a verified CRX into a staging folder and reads what the prompt needs. */
export async function stageWebStoreExtension(crx: VerifiedCrx): Promise<StagedWebStoreExtension> {
  const entries = readBrowserExtensionArchive(crx.archive)
  const manifestEntry = entries.find((entry) => entry.path === 'manifest.json')
  if (!manifestEntry) {
    throw new Error('Extension package has no manifest')
  }
  const manifest = parseManifest(manifestEntry.data)
  // Why: Electron derives an unpacked extension's id from manifest.key, so it matches the store id.
  manifest.key = crx.publicKey.toString('base64')
  const directory = join(
    getBrowserExtensionInstallStore().root,
    crx.extensionId,
    `${STAGING_PREFIX}${randomUUID()}`
  )
  try {
    await writeBrowserExtensionArchive(
      entries.filter((entry) => entry !== manifestEntry),
      directory
    )
    // Why here: once Orca's own files are written, a package file at their paths can't be told apart.
    await refuseOrcaFileCollisions(directory, manifest)
    const manifestText = JSON.stringify(manifest, null, 2)
    await writeFile(join(directory, 'manifest.json'), manifestText)
    // Why written here: the manifest Orca later loads is always the one this prompt shows.
    await writeFile(join(directory, BROWSER_EXTENSION_ORIGINAL_MANIFEST_FILE), manifestText)
    return {
      extensionId: crx.extensionId,
      version: String(manifest.version),
      directory,
      summary: await readBrowserExtensionManifest(directory),
      access: summarizeManifestPermissions(manifest)
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function discardStagedWebStoreExtension(
  staged: StagedWebStoreExtension
): Promise<void> {
  await rm(staged.directory, { recursive: true, force: true })
}

function isOwnedVersionFolder(extensionId: string, path: string): boolean {
  const owned = resolve(getBrowserExtensionInstallStore().root, extensionId)
  const rel = relative(owned, resolve(path))
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Moves a staged version into `<root>/<id>/<version>/`, records it, reloads it wherever it is on,
 * turns it on in `enableInProfileId`, and only then deletes the version it replaced.
 */
export async function commitStagedWebStoreExtension(
  staged: StagedWebStoreExtension,
  enableInProfileId: string | null
): Promise<InstalledBrowserExtension> {
  const store = getBrowserExtensionInstallStore()
  const { extensionId } = staged
  const previous = store.get(extensionId)
  if (previous?.source === 'unpacked') {
    await discardStagedWebStoreExtension(staged)
    throw new Error(
      `${previous.name} is loaded unpacked; remove it before installing from the store`
    )
  }
  const target = store.installDirectory(extensionId, staged.version)
  if (previous?.path === target) {
    // Same version already in use: keep the loaded folder untouched.
    await discardStagedWebStoreExtension(staged)
  } else {
    await rm(target, { recursive: true, force: true })
    await rename(staged.directory, target)
  }
  const { summary } = staged
  const record = store.save({
    id: extensionId,
    name: summary.name,
    version: staged.version,
    path: target,
    source: 'webstore',
    iconPath: summary.iconPath,
    permissions: summary.permissions,
    hostPermissions: summary.hostPermissions,
    optionsPage: summary.optionsPage
  })
  const replaced = previous && previous.path !== target ? previous : null
  try {
    if (replaced) {
      await reloadBrowserExtensionWhereEnabled(record)
    }
    if (enableInProfileId) {
      await loadBrowserExtensionIntoProfile(enableInProfileId, record)
      browserSessionRegistry.updateEnabledExtensionIds((byProfile) =>
        withExtensionEnabled(byProfile, enableInProfileId, extensionId, true)
      )
    }
  } catch (error) {
    if (replaced) {
      store.save(replaced)
      await reloadBrowserExtensionWhereEnabled(replaced).catch(() => {})
      await rm(target, { recursive: true, force: true })
    } else if (!previous) {
      await unloadBrowserExtensionEverywhere(extensionId)
      await store.remove(extensionId)
    }
    throw error
  }
  if (replaced && isOwnedVersionFolder(extensionId, replaced.path)) {
    await rm(replaced.path, { recursive: true, force: true, maxRetries: 3 })
  }
  if (getHeldBrowserExtensionUpdate(extensionId)?.version === record.version) {
    forgetHeldBrowserExtensionUpdate(extensionId)
  }
  notifyBrowserExtensionListChanged()
  return record
}
