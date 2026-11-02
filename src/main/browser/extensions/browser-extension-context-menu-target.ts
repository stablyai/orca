/// <reference types="chrome" />
import type {
  BrowserExtensionContextMenuGroup,
  BrowserExtensionContextMenuItem
} from '../../../shared/browser-extension-context-menu-types'
import { sameId } from './browser-extension-context-menu-model'
import { matchesExtensionMatchPattern } from './browser-extension-match-pattern'
import type { StoredContextMenuItem } from './browser-extension-profile-state-store'

/** Which extension menu items a right-click (or the toolbar menu) shows, and what a click reports. */

type MenuItemId = string | number

export const ACTION_MENU_CONTEXTS = ['action', 'browser_action', 'page_action'] as const

/** What was right-clicked, in the terms context menu filters use. */
export type ContextMenuTarget = {
  contexts: ReadonlySet<string>
  pageUrl: string
  frameUrl?: string
  linkUrl?: string
  srcUrl?: string
  selectionText?: string
}

export type ContextMenuParamsLike = {
  pageURL?: string
  frameURL?: string
  linkURL?: string
  srcURL?: string
  mediaType?: string
  selectionText?: string
  isEditable?: boolean
}

/** Chromium: 'page' applies only when no link, selection, editable or media context does. */
export function contextMenuTargetFromParams(
  params: ContextMenuParamsLike,
  pageUrl: string,
  inSubframe: boolean
): ContextMenuTarget {
  const contexts = new Set<string>()
  if (params.linkURL) {
    contexts.add('link')
  }
  if (params.isEditable) {
    contexts.add('editable')
  }
  if (params.selectionText) {
    contexts.add('selection')
  }
  if (
    params.mediaType === 'image' ||
    params.mediaType === 'video' ||
    params.mediaType === 'audio'
  ) {
    contexts.add(params.mediaType)
  }
  if (contexts.size === 0) {
    contexts.add('page')
  }
  if (inSubframe) {
    contexts.add('frame')
  }
  return {
    contexts,
    pageUrl,
    ...(inSubframe && params.frameURL ? { frameUrl: params.frameURL } : {}),
    ...(params.linkURL ? { linkUrl: params.linkURL } : {}),
    ...(params.srcURL ? { srcUrl: params.srcURL } : {}),
    ...(params.selectionText ? { selectionText: params.selectionText } : {})
  }
}

function matchesAny(patterns: string[] | undefined, url: string | undefined): boolean {
  return (
    !patterns ||
    (url !== undefined && patterns.some((pattern) => matchesExtensionMatchPattern(pattern, url)))
  )
}

function itemApplies(item: StoredContextMenuItem, target: ContextMenuTarget): boolean {
  if (!item.visible) {
    return false
  }
  const contextMatches =
    item.contexts.includes('all') || item.contexts.some((context) => target.contexts.has(context))
  if (!contextMatches) {
    return false
  }
  if (!matchesAny(item.documentUrlPatterns, target.frameUrl ?? target.pageUrl)) {
    return false
  }
  if (item.targetUrlPatterns) {
    for (const url of [target.linkUrl, target.srcUrl]) {
      if (url && !matchesAny(item.targetUrlPatterns, url)) {
        return false
      }
    }
  }
  return true
}

const MAX_SELECTION_IN_TITLE = 50

/** %s → the selection (as Chrome truncates it); single & are Chrome mnemonics, && a literal &. */
export function formatContextMenuTitle(title: string, selectionText: string | undefined): string {
  const selection =
    selectionText && selectionText.length > MAX_SELECTION_IN_TITLE
      ? `${selectionText.slice(0, MAX_SELECTION_IN_TITLE)}…`
      : (selectionText ?? '')
  return title.replaceAll('%s', selection).replace(/&(&?)/g, (_match, literal: string) => literal)
}

export function visibleContextMenuTree(
  items: StoredContextMenuItem[],
  target: ContextMenuTarget,
  parentId?: MenuItemId
): BrowserExtensionContextMenuItem[] {
  return items
    .filter((item) =>
      parentId === undefined ? item.parentId === undefined : sameId(item.parentId, parentId)
    )
    .filter((item) => itemApplies(item, target))
    .flatMap((item): BrowserExtensionContextMenuItem[] => {
      const hasChildren = items.some((candidate) => sameId(candidate.parentId, item.id))
      const children = hasChildren ? visibleContextMenuTree(items, target, item.id) : []
      // Why: a parent whose children were all filtered out is an empty submenu.
      if (hasChildren && children.length === 0) {
        return []
      }
      return [
        {
          key: JSON.stringify(item.id),
          title: formatContextMenuTitle(item.title ?? '', target.selectionText),
          type: item.type,
          checked: item.checked === true,
          enabled: item.enabled,
          children
        }
      ]
    })
}

/** Chrome: one top-level item shows inline; several go under a submenu named after the extension. */
export function arrangeExtensionContextMenuGroup(
  extensionId: string,
  extensionName: string,
  tree: BrowserExtensionContextMenuItem[]
): BrowserExtensionContextMenuGroup | null {
  const items = tree.filter((item) => item.type !== 'separator' || tree.length > 1)
  if (items.length === 0) {
    return null
  }
  if (items.length === 1) {
    return { extensionId, items }
  }
  return {
    extensionId,
    items: [
      {
        key: '',
        title: extensionName,
        type: 'normal',
        checked: false,
        enabled: true,
        children: items
      }
    ]
  }
}

/** chrome.contextMenus.OnClickData for a page right-click. */
export function buildContextMenuOnClickData(args: {
  item: StoredContextMenuItem
  target: ContextMenuTarget
  frameId: number
  editable: boolean
  mediaType?: string
  wasChecked?: boolean
  checked?: boolean
}): chrome.contextMenus.OnClickData {
  const { item, target } = args
  return {
    menuItemId: item.id,
    ...(item.parentId !== undefined ? { parentMenuItemId: item.parentId } : {}),
    ...(args.mediaType === 'image' || args.mediaType === 'video' || args.mediaType === 'audio'
      ? { mediaType: args.mediaType }
      : {}),
    ...(target.linkUrl ? { linkUrl: target.linkUrl } : {}),
    ...(target.srcUrl ? { srcUrl: target.srcUrl } : {}),
    pageUrl: target.pageUrl,
    ...(target.frameUrl ? { frameUrl: target.frameUrl } : {}),
    frameId: args.frameId,
    ...(target.selectionText ? { selectionText: target.selectionText } : {}),
    editable: args.editable,
    ...(args.wasChecked !== undefined ? { wasChecked: args.wasChecked } : {}),
    ...(args.checked !== undefined ? { checked: args.checked } : {})
  }
}
