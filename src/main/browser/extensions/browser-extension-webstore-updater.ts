import { net } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  hasBrowserExtensionWarnings,
  newBrowserExtensionWarnings
} from '../../../shared/browser-extension-permission-warnings'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import {
  forgetHeldBrowserExtensionUpdate,
  getHeldBrowserExtensionUpdate,
  holdBrowserExtensionUpdate
} from './browser-extension-held-updates'
import { requestBrowserExtensionInstallPrompt } from './browser-extension-install-prompt'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { readBrowserExtensionIconDataUrl } from './browser-extension-manifest'
import {
  samePermissionSummary,
  summarizeManifestPermissions
} from './browser-extension-permission-summary'
import { downloadWebStoreCrx, isAllowedCrxDownloadUrl } from './browser-extension-webstore-download'
import {
  commitStagedWebStoreExtension,
  discardStagedWebStoreExtension,
  isBrowserExtensionBusy,
  stageWebStoreExtension,
  withBrowserExtensionLock,
  type StagedWebStoreExtension
} from './browser-extension-webstore-install'

/**
 * Background updates for store installs. Request shape follows electron-chrome-web-store's
 * updater (MIT, Samuel Maddock): Omaha 3.1 JSON without versions, compared locally.
 */

const UPDATE_CHECK_URL = 'https://update.googleapis.com/service/update2/json'
const FIRST_CHECK_DELAY_MS = 60_000
const CHECK_INTERVAL_MS = 5 * 60 * 60_000
const RESPONSE_PREFIX = ")]}'"

export type BrowserExtensionUpdate = {
  extensionId: string
  version: string
  url: string
  sha256: string | undefined
  size: number | undefined
}

/** Chrome versions: up to four dot-separated integers; missing parts count as 0. */
export function compareExtensionVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return Math.sign(difference)
    }
  }
  return 0
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Newer versions offered for the installed extensions; anything malformed is skipped. */
export function parseOmahaUpdateResponse(
  text: string,
  installedVersions: ReadonlyMap<string, string>
): BrowserExtensionUpdate[] {
  const body = text.startsWith(RESPONSE_PREFIX) ? text.slice(RESPONSE_PREFIX.length) : text
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const updates: BrowserExtensionUpdate[] = []
  for (const app of list(record(record(parsed).response).app)) {
    const entry = record(app)
    const updateCheck = record(entry.updatecheck)
    const extensionId = entry.appid
    const installed =
      typeof extensionId === 'string' ? installedVersions.get(extensionId) : undefined
    const manifest = record(updateCheck.manifest)
    const pkg = record(list(record(manifest.packages).package)[0])
    const codebase = record(list(record(updateCheck.urls).url)[0]).codebase
    if (
      typeof extensionId !== 'string' ||
      installed === undefined ||
      updateCheck.status !== 'ok' ||
      typeof manifest.version !== 'string' ||
      typeof pkg.name !== 'string' ||
      typeof codebase !== 'string' ||
      compareExtensionVersions(manifest.version, installed) <= 0
    ) {
      continue
    }
    let url: string
    try {
      url = new URL(pkg.name, codebase).toString()
    } catch {
      continue
    }
    if (!isAllowedCrxDownloadUrl(url)) {
      continue
    }
    updates.push({
      extensionId,
      version: manifest.version,
      url,
      sha256: typeof pkg.hash_sha256 === 'string' ? pkg.hash_sha256 : undefined,
      size: typeof pkg.size === 'number' ? pkg.size : undefined
    })
  }
  return updates
}

function omahaPlatform(): string {
  return process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
}

async function fetchAvailableUpdates(
  extensions: InstalledBrowserExtension[]
): Promise<BrowserExtensionUpdate[]> {
  const chromeVersion = process.versions.chrome
  const response = await net.fetch(UPDATE_CHECK_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Update-Interactivity': 'bg',
      'X-Goog-Update-AppId': extensions.map((extension) => extension.id).join(','),
      'X-Goog-Update-Updater': `chromiumcrx-${chromeVersion}`
    },
    body: JSON.stringify({
      request: {
        '@updater': 'chromiumcrx',
        acceptformat: 'crx3',
        app: extensions.map((extension) => ({ appid: extension.id, updatecheck: {} })),
        os: { platform: omahaPlatform(), arch: process.arch === 'ia32' ? 'x86' : process.arch },
        prodversion: chromeVersion,
        protocol: '3.1',
        requestid: `{${randomUUID()}}`,
        sessionid: `{${randomUUID()}}`
      }
    })
  })
  if (!response.ok) {
    throw new Error(`Update check failed (${response.status})`)
  }
  return parseOmahaUpdateResponse(
    await response.text(),
    new Map(extensions.map((extension) => [extension.id, extension.version]))
  )
}

async function installedAccess(
  extension: InstalledBrowserExtension
): Promise<ReturnType<typeof summarizeManifestPermissions>> {
  const raw = await readFile(join(extension.path, 'manifest.json'), 'utf8')
  return summarizeManifestPermissions(JSON.parse(raw.replace(/^﻿/, '')))
}

/** Downloads and stages the update; null (nothing staged) when it is not newer than what runs. */
async function stageUpdate(
  extension: InstalledBrowserExtension,
  update: Pick<BrowserExtensionUpdate, 'url' | 'sha256' | 'size'>
): Promise<StagedWebStoreExtension | null> {
  const crx = await downloadWebStoreCrx(extension.id, {
    url: update.url,
    sha256: update.sha256,
    size: update.size
  })
  const staged = await stageWebStoreExtension(crx)
  if (compareExtensionVersions(staged.version, extension.version) <= 0) {
    await discardStagedWebStoreExtension(staged)
    return null
  }
  return staged
}

async function applyUpdate(
  extension: InstalledBrowserExtension,
  update: BrowserExtensionUpdate
): Promise<void> {
  await withBrowserExtensionLock(extension.id, async () => {
    const granted = await installedAccess(extension)
    const staged = await stageUpdate(extension, update)
    if (!staged) {
      return
    }
    // Why hold: like Chrome, an update whose warnings grow waits for the user (Settings › Review access).
    const newWarnings = newBrowserExtensionWarnings(staged.access, granted)
    if (hasBrowserExtensionWarnings(newWarnings)) {
      await discardStagedWebStoreExtension(staged)
      holdBrowserExtensionUpdate(extension.id, {
        version: staged.version,
        url: update.url,
        sha256: update.sha256,
        size: update.size,
        access: staged.access,
        newWarnings
      })
      return
    }
    await commitStagedWebStoreExtension(staged, null)
    forgetHeldBrowserExtensionUpdate(extension.id)
  })
}

/** Settings › Review access: asks about the new warnings only, then installs exactly that package. */
export async function reviewHeldBrowserExtensionUpdate(
  extensionId: string,
  renderer: Electron.WebContents
): Promise<void> {
  const held = getHeldBrowserExtensionUpdate(extensionId)
  const extension = getBrowserExtensionInstallStore().get(extensionId)
  if (!held || extension?.source !== 'webstore') {
    forgetHeldBrowserExtensionUpdate(extensionId)
    throw new Error('No update is waiting for this extension')
  }
  const accepted = await requestBrowserExtensionInstallPrompt(renderer, {
    kind: 'permissions',
    name: extension.name,
    iconDataUrl: await readBrowserExtensionIconDataUrl(extension.path, extension.iconPath),
    permissions: held.newWarnings.permissions,
    hostPermissions: held.newWarnings.hostPermissions,
    profileLabel: null
  })
  if (!accepted) {
    return
  }
  await withBrowserExtensionLock(extensionId, async () => {
    const staged = await stageUpdate(extension, held)
    forgetHeldBrowserExtensionUpdate(extensionId)
    if (!staged) {
      return
    }
    if (!samePermissionSummary(staged.access, held.access)) {
      await discardStagedWebStoreExtension(staged)
      throw new Error('The update changed since Orca checked it; it will be offered again')
    }
    await commitStagedWebStoreExtension(staged, null)
  })
}

let checking = false

export async function checkForBrowserExtensionUpdates(): Promise<void> {
  if (checking) {
    return
  }
  checking = true
  try {
    const extensions = getBrowserExtensionInstallStore()
      .list()
      .filter((extension) => extension.source === 'webstore')
    if (extensions.length === 0) {
      return
    }
    const byId = new Map(extensions.map((extension) => [extension.id, extension]))
    const updates = await fetchAvailableUpdates(extensions)
    const offered = new Set(updates.map((update) => update.extensionId))
    for (const extension of extensions) {
      if (!offered.has(extension.id)) {
        forgetHeldBrowserExtensionUpdate(extension.id)
      }
    }
    for (const update of updates) {
      const extension = byId.get(update.extensionId)
      // Why skip a held version: it would download again only to be held again.
      if (
        !extension ||
        isBrowserExtensionBusy(extension.id) ||
        getHeldBrowserExtensionUpdate(extension.id)?.version === update.version
      ) {
        continue
      }
      try {
        await applyUpdate(extension, update)
      } catch (error) {
        console.warn(`[browser-extensions] Updating ${extension.name} failed:`, error)
      }
    }
  } catch (error) {
    console.warn('[browser-extensions] Update check failed:', error)
  } finally {
    checking = false
  }
}

let started = false

/** Checks shortly after launch and then every five hours, off the startup path. */
export function startBrowserExtensionUpdateChecks(): void {
  if (started) {
    return
  }
  started = true
  setTimeout(() => void checkForBrowserExtensionUpdates(), FIRST_CHECK_DELAY_MS).unref()
  setInterval(() => void checkForBrowserExtensionUpdates(), CHECK_INTERVAL_MS).unref()
}
