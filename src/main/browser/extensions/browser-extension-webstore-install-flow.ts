import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { isChromeExtensionId } from '../../../shared/browser-extension-url'
import type {
  BrowserExtensionInstallPromptRequest,
  ChromeWebStoreReply
} from '../../../shared/browser-extension-webstore'
import {
  summarizeManifestPermissions,
  type BrowserExtensionPermissionSummary
} from './browser-extension-permission-summary'

/**
 * The store page's install state machine (Chromium's webstorePrivate semantics): begin validates
 * and asks the user, leaving a short-lived approval for that frame; complete consumes it.
 */

export const CHROME_WEB_STORE_APPROVAL_TTL_MS = 2 * 60_000

/** The store tab's top frame, as main resolved it from the IPC sender. */
export type ChromeWebStoreFrame = {
  webContentsId: number
  frameTreeNodeId: number
  profileId: string
  /** Same document origin, same profile, frame and tab still alive. */
  isStillValid: () => boolean
}

export type ChromeWebStoreBeginDetails = {
  id: string
  manifest: string
  localizedName?: string
  iconUrl?: string
}

export type ChromeWebStorePrompt = Omit<BrowserExtensionInstallPromptRequest, 'requestId'>

export type ChromeWebStoreInstallFlowDeps = {
  now: () => number
  isEnabledInProfile: (profileId: string, extensionId: string) => boolean
  isBusy: (extensionId: string) => boolean
  profileLabel: (profileId: string) => string | null
  /** Resolves a data URL; throws InvalidIconUrl for a URL outside the allowed hosts. */
  loadIcon: (frame: ChromeWebStoreFrame, iconUrl: string) => Promise<string>
  confirm: (frame: ChromeWebStoreFrame, prompt: ChromeWebStorePrompt) => Promise<boolean>
  /** Downloads, verifies, checks the approved access and commits; returns the installed record. */
  install: (
    frame: ChromeWebStoreFrame,
    extensionId: string,
    approved: BrowserExtensionPermissionSummary
  ) => Promise<InstalledBrowserExtension>
  describeInstalled: (
    extensionId: string
  ) => Promise<{ name: string; iconDataUrl: string | null } | null>
  uninstall: (extensionId: string) => Promise<void>
  notifyInstalled: (extension: InstalledBrowserExtension) => void
  notifyUninstalled: (extensionId: string) => void
}

export class InvalidIconUrlError extends Error {}

type Approval = { access: BrowserExtensionPermissionSummary; expiresAt: number }

function approvalKey(frame: ChromeWebStoreFrame, extensionId: string): string {
  return `${frame.webContentsId}:${frame.frameTreeNodeId}:${extensionId}`
}

function parseStoreManifest(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const manifest = Object.fromEntries(Object.entries(parsed))
    return typeof manifest.name === 'string' && typeof manifest.version === 'string'
      ? manifest
      : null
  } catch {
    return null
  }
}

function isDeprecatedManifestVersion(manifest: Record<string, unknown>): boolean {
  const version = manifest.manifest_version
  return typeof version !== 'number' || version < 3
}

/** webstorePrivate.getExtensionStatus for one profile. */
export function chromeWebStoreExtensionStatus(
  enabledInProfile: boolean,
  rawManifest: string | null
): string {
  if (enabledInProfile) {
    return 'enabled'
  }
  const manifest = rawManifest ? parseStoreManifest(rawManifest) : null
  return manifest && isDeprecatedManifestVersion(manifest)
    ? 'deprecated_manifest_version'
    : 'installable'
}

const USER_CANCELLED: ChromeWebStoreReply = {
  value: 'user_cancelled',
  error: 'User cancelled install'
}

export class ChromeWebStoreInstallFlow {
  private readonly approvals = new Map<string, Approval>()
  private readonly prompting = new Set<string>()

  constructor(private readonly deps: ChromeWebStoreInstallFlowDeps) {}

  async begin(
    frame: ChromeWebStoreFrame,
    details: ChromeWebStoreBeginDetails
  ): Promise<ChromeWebStoreReply> {
    if (!isChromeExtensionId(details.id)) {
      return { value: 'invalid_id', error: 'Invalid id' }
    }
    const key = approvalKey(frame, details.id)
    if (this.deps.isEnabledInProfile(frame.profileId, details.id)) {
      return { value: 'already_installed', error: 'This item is already installed' }
    }
    const pendingApproval = this.approvals.get(key)
    if (
      this.prompting.has(key) ||
      this.deps.isBusy(details.id) ||
      (pendingApproval && pendingApproval.expiresAt > this.deps.now())
    ) {
      return {
        value: 'install_in_progress',
        error: 'An installation of the same extension is already in progress'
      }
    }
    const manifest = parseStoreManifest(details.manifest)
    if (!manifest) {
      return { value: 'manifest_error', error: 'Invalid manifest' }
    }
    if ('theme' in manifest || 'app' in manifest) {
      return { value: 'unsupported_extension_type', error: 'Orca can install extensions only' }
    }
    if (isDeprecatedManifestVersion(manifest)) {
      return { value: 'manifest_error', error: 'Manifest version 2 is no longer supported' }
    }
    let iconDataUrl: string | null = null
    if (details.iconUrl) {
      try {
        iconDataUrl = await this.deps.loadIcon(frame, details.iconUrl)
      } catch (error) {
        return error instanceof InvalidIconUrlError
          ? { value: 'invalid_icon_url', error: 'Invalid icon url' }
          : { value: 'icon_error', error: 'Icon could not be loaded' }
      }
    }
    const access = summarizeManifestPermissions(manifest)
    this.prompting.add(key)
    let accepted = false
    try {
      accepted = await this.deps.confirm(frame, {
        kind: 'install',
        name: details.localizedName?.trim() || String(manifest.name),
        iconDataUrl,
        permissions: access.permissions,
        hostPermissions: access.hostPermissions,
        profileLabel: this.deps.profileLabel(frame.profileId)
      })
    } finally {
      this.prompting.delete(key)
    }
    // Why re-check: the tab may have navigated or closed while the prompt was open.
    if (!accepted || !frame.isStillValid()) {
      return USER_CANCELLED
    }
    this.approvals.set(key, {
      access,
      expiresAt: this.deps.now() + CHROME_WEB_STORE_APPROVAL_TTL_MS
    })
    return { value: '' }
  }

  async complete(frame: ChromeWebStoreFrame, extensionId: string): Promise<ChromeWebStoreReply> {
    const key = approvalKey(frame, extensionId)
    const approval = this.approvals.get(key)
    this.approvals.delete(key)
    if (!approval || approval.expiresAt <= this.deps.now() || !frame.isStillValid()) {
      return { error: `${extensionId} does not match a previous call to beginInstallWithManifest3` }
    }
    let installed: InstalledBrowserExtension
    try {
      installed = await this.deps.install(frame, extensionId, approval.access)
    } catch (error) {
      // Why: the store re-reads its button only on management events.
      this.deps.notifyUninstalled(extensionId)
      return { error: error instanceof Error && error.message ? error.message : 'Install failed' }
    }
    this.deps.notifyInstalled(installed)
    return {}
  }

  async uninstall(frame: ChromeWebStoreFrame, extensionId: string): Promise<ChromeWebStoreReply> {
    const installed = isChromeExtensionId(extensionId)
      ? await this.deps.describeInstalled(extensionId)
      : null
    if (!installed) {
      return { error: `Failed to find extension with id ${extensionId}.` }
    }
    // Why always prompt: a web page must never remove an extension silently.
    const accepted = await this.deps.confirm(frame, {
      kind: 'uninstall',
      name: installed.name,
      iconDataUrl: installed.iconDataUrl,
      permissions: [],
      hostPermissions: [],
      profileLabel: null
    })
    if (!accepted || !frame.isStillValid()) {
      return { error: `Extension ${extensionId} uninstall canceled by user.` }
    }
    try {
      await this.deps.uninstall(extensionId)
    } catch (error) {
      return { error: error instanceof Error && error.message ? error.message : 'Uninstall failed' }
    }
    return {}
  }
}
