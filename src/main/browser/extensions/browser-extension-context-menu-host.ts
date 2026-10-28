import { randomUUID } from 'node:crypto'
import type {
  BrowserExtensionContextMenuClick,
  BrowserExtensionContextMenuGroup,
  BrowserExtensionContextMenuPayload
} from '../../../shared/browser-extension-context-menu-types'
import { chromeFrameId } from './api/web-navigation'
import { noteBrowserExtensionUserGesture } from './api/permissions'
import {
  emitBrowserExtensionEvent,
  getBrowserExtensionProfileIdForSession
} from './browser-extension-api-host'
import {
  applyContextMenuClick,
  findContextMenuItemByKey
} from './browser-extension-context-menu-model'
import {
  ACTION_MENU_CONTEXTS,
  arrangeExtensionContextMenuGroup,
  buildContextMenuOnClickData,
  contextMenuTargetFromParams,
  visibleContextMenuTree,
  type ContextMenuTarget
} from './browser-extension-context-menu-target'
import { grantBrowserExtensionActiveTab } from './browser-extension-active-tab'
import { getBrowserExtensionDocumentId } from './browser-extension-document-ids'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { extensionHasPermission } from './browser-extension-namespace-registry'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import { getBrowserExtensionSessionForProfile } from './browser-extension-session-loader'
import { isBrowserExtensionSupportEnabled } from './browser-extension-support'
import {
  describeBrowserExtensionTab,
  resolveBrowserExtensionTab
} from './browser-extension-tab-model'

/** What a click needs, kept in main so the renderer only names a token and an item key. */
type MenuSnapshot = {
  session: Electron.Session
  profileId: string
  tabId: number | null
  /** The tab's top document when the menu opened; a click after it navigates does nothing. */
  documentId: string | null
  target: ContextMenuTarget
  frameId: number
  editable: boolean
  mediaType?: string
  createdAt: number
}

const SNAPSHOT_TTL_MS = 10 * 60_000
const snapshots = new Map<string, MenuSnapshot>()

function pruneSnapshots(now: number): void {
  for (const [token, snapshot] of snapshots) {
    if (now - snapshot.createdAt > SNAPSHOT_TTL_MS) {
      snapshots.delete(token)
    }
  }
}

function topDocumentId(tabId: number | null): string | null {
  const contents = tabId === null ? null : resolveBrowserExtensionTab(tabId)?.contents
  return contents ? getBrowserExtensionDocumentId(contents.mainFrame.frameTreeNodeId) : null
}

function extensionDisplayName(extension: Electron.Extension): string {
  return getBrowserExtensionInstallStore().get(extension.id)?.name ?? extension.name
}

function menuExtensions(session: Electron.Session): Electron.Extension[] {
  return session.extensions
    .getAllExtensions()
    .filter((extension) => extensionHasPermission(extension, 'contextMenus', session))
    .sort((a, b) => extensionDisplayName(a).localeCompare(extensionDisplayName(b)))
}

function groupsFor(
  session: Electron.Session,
  profileId: string,
  target: ContextMenuTarget
): BrowserExtensionContextMenuGroup[] {
  const store = getBrowserExtensionProfileStateStore()
  return menuExtensions(session).flatMap((extension) => {
    const items = store.read(profileId, extension.id).contextMenus
    const group = arrangeExtensionContextMenuGroup(
      extension.id,
      extensionDisplayName(extension),
      visibleContextMenuTree(items, target)
    )
    return group ? [group] : []
  })
}

/** Extension items for a page right-click in a guest whose session runs extensions. */
export function buildBrowserExtensionPageContextMenu(
  guest: Electron.WebContents,
  params: Electron.ContextMenuParams
): BrowserExtensionContextMenuPayload | null {
  if (!isBrowserExtensionSupportEnabled()) {
    return null
  }
  const session = guest.session
  const profileId = getBrowserExtensionProfileIdForSession(session)
  if (!profileId) {
    return null
  }
  const frame = params.frame && !params.frame.isDestroyed() ? params.frame : null
  const target = contextMenuTargetFromParams(params, guest.getURL(), Boolean(frame?.parent))
  const groups = groupsFor(session, profileId, target)
  if (groups.length === 0) {
    return null
  }
  const now = Date.now()
  pruneSnapshots(now)
  const token = randomUUID()
  const tabId = resolveBrowserExtensionTab(guest.id) ? guest.id : null
  snapshots.set(token, {
    session,
    profileId,
    tabId,
    documentId: topDocumentId(tabId),
    target,
    frameId: frame ? chromeFrameId(frame) : 0,
    editable: params.isEditable,
    mediaType: params.mediaType,
    createdAt: now
  })
  return { token, groups }
}

function runClick(snapshot: MenuSnapshot, extensionId: string, key: string): boolean {
  // Chrome drops an extension item click once the menu's frame is gone (RenderViewContextMenu).
  if (topDocumentId(snapshot.tabId) !== snapshot.documentId) {
    return false
  }
  const extension = snapshot.session.extensions.getExtension(extensionId)
  if (!extension || !extensionHasPermission(extension, 'contextMenus', snapshot.session)) {
    return false
  }
  const store = getBrowserExtensionProfileStateStore()
  const items = store.read(snapshot.profileId, extensionId).contextMenus
  const item = findContextMenuItemByKey(items, key)
  // Why re-check: the item may have been hidden, disabled or removed while the menu was open.
  if (
    !item ||
    !item.enabled ||
    item.type === 'separator' ||
    !visibleContextMenuTree(items, snapshot.target, item.parentId).some(
      (entry) => entry.key === key
    )
  ) {
    return false
  }
  const click = applyContextMenuClick(items, item)
  if (click.items !== items) {
    store.update(snapshot.profileId, extensionId, (state) => ({
      ...state,
      contextMenus: click.items
    }))
  }
  const info = buildContextMenuOnClickData({
    item,
    target: snapshot.target,
    frameId: snapshot.frameId,
    editable: snapshot.editable,
    mediaType: snapshot.mediaType,
    wasChecked: click.wasChecked,
    checked: click.checked
  })
  const entry = snapshot.tabId === null ? null : resolveBrowserExtensionTab(snapshot.tabId)
  if (entry) {
    grantBrowserExtensionActiveTab(extension, entry.contents.id)
  }
  const tab = entry ? describeBrowserExtensionTab(extension, entry) : undefined
  noteBrowserExtensionUserGesture(snapshot.session, extensionId)
  emitBrowserExtensionEvent(
    { session: snapshot.session, extensionId },
    'contextMenus',
    'onClicked',
    tab ? [info, tab] : [info]
  )
  return true
}

export function runBrowserExtensionContextMenuClick(
  click: BrowserExtensionContextMenuClick
): boolean {
  const snapshot = snapshots.get(click.token)
  if (!snapshot) {
    return false
  }
  // Why one-shot: a menu is clicked once; a replayed token must not fire again.
  snapshots.delete(click.token)
  return runClick(snapshot, click.extensionId, click.key)
}

function actionTarget(tabId: number | null): ContextMenuTarget {
  const contents = tabId === null ? null : resolveBrowserExtensionTab(tabId)?.contents
  return { contexts: new Set(ACTION_MENU_CONTEXTS), pageUrl: contents?.getURL() ?? '' }
}

/**
 * For the toolbar button's own menu (Wave 2B): this extension's 'action' context items, or null.
 * Pass the returned token with an item key to runBrowserExtensionContextMenuClick.
 */
export function buildBrowserExtensionActionContextMenu(
  browserProfileId: string,
  extensionId: string,
  tabId: number | null
): BrowserExtensionContextMenuPayload | null {
  const session = getBrowserExtensionSessionForProfile(browserProfileId)
  const extension = session?.extensions.getExtension(extensionId)
  if (!session || !extension || !extensionHasPermission(extension, 'contextMenus', session)) {
    return null
  }
  const target = actionTarget(tabId)
  // Why no wrapping submenu: the toolbar menu already belongs to this one extension.
  const items = visibleContextMenuTree(
    getBrowserExtensionProfileStateStore().read(browserProfileId, extensionId).contextMenus,
    target
  )
  if (items.length === 0) {
    return null
  }
  const groups = [{ extensionId, items }]
  const now = Date.now()
  pruneSnapshots(now)
  const token = randomUUID()
  snapshots.set(token, {
    session,
    profileId: browserProfileId,
    tabId,
    documentId: topDocumentId(tabId),
    target,
    frameId: 0,
    editable: false,
    createdAt: now
  })
  return { token, groups }
}
