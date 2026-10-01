import { Menu, MenuItem, nativeImage, type Session, type WebContents } from 'electron'
import { join } from 'node:path'
import type { BrowserExtensionMenuItem } from '../../../shared/browser-guest-events'
import { emitExtensionEvent, handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import { objectArg } from './extension-api-args'
import { matchesUrlPattern } from './extension-match-pattern'
import { tabDetails } from './extension-tab-registry'
import { extensionFrameId } from './extension-web-navigation'

type MenuProperties = Record<string, unknown> & { id: string | number }
type ItemsById = Map<string | number, MenuProperties>

const menusBySession = new WeakMap<Session, Map<string, ItemsById>>()
const shownByTab = new WeakMap<WebContents, MenuItem[]>()
const SELECTION_TITLE_LIMIT = 32

function menusOf(session: Session, extensionId: string): ItemsById {
  let menus = menusBySession.get(session)
  if (!menus) {
    menus = new Map()
    menusBySession.set(session, menus)
    session.extensions.on('extension-unloaded', (_event, extension) => menus?.delete(extension.id))
  }
  let items = menus.get(extensionId)
  if (!items) {
    items = new Map()
    menus.set(extensionId, items)
  }
  return items
}

function menuId(value: unknown): string | number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('A menu item id is a string or number')
  }
  return value
}

function removeWithChildren(items: ItemsById, id: string | number): void {
  for (const [childId, child] of items) {
    if (child.parentId === id) {
      removeWithChildren(items, childId)
    }
  }
  items.delete(id)
}

handleExtensionApi('contextMenus', {
  create: (caller: ExtensionCaller, properties: unknown) => {
    const props = objectArg(properties)
    const id = menuId(props.id)
    menusOf(caller.session, caller.extension.id).set(id, { ...props, id })
  },
  update: (caller: ExtensionCaller, id: unknown, properties: unknown) => {
    const items = menusOf(caller.session, caller.extension.id)
    const item = items.get(menuId(id))
    if (!item) {
      throw new Error(`Cannot find menu item with id ${String(id)}`)
    }
    items.set(item.id, { ...item, ...objectArg(properties), id: item.id })
  },
  remove: (caller: ExtensionCaller, id: unknown) =>
    removeWithChildren(menusOf(caller.session, caller.extension.id), menuId(id)),
  removeAll: (caller: ExtensionCaller) => menusOf(caller.session, caller.extension.id).clear()
})

/** The chrome.contextMenus contexts a right-click is in. */
function contextsOf(params: Electron.ContextMenuParams): Set<string> {
  const contexts = new Set(['all'])
  if (params.selectionText) {
    contexts.add('selection')
  }
  if (params.linkURL) {
    contexts.add('link')
  }
  if (params.isEditable) {
    contexts.add('editable')
  }
  if (
    params.mediaType === 'image' ||
    params.mediaType === 'video' ||
    params.mediaType === 'audio'
  ) {
    contexts.add(params.mediaType)
  }
  if (params.frame?.parent) {
    contexts.add('frame')
  }
  // Chrome shows "page" items only when the click is on nothing more specific.
  if (contexts.size === (contexts.has('frame') ? 2 : 1)) {
    contexts.add('page')
  }
  return contexts
}

function applies(props: MenuProperties, params: Electron.ContextMenuParams): boolean {
  const contexts = contextsOf(params)
  const wanted = [props.contexts ?? 'page'].flat()
  const patterns = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
  const documentPatterns = patterns(props.documentUrlPatterns)
  const targetPatterns = patterns(props.targetUrlPatterns)
  const documentUrl = params.frameURL || params.pageURL
  const targetUrl = params.linkURL || params.srcURL
  return (
    props.visible !== false &&
    wanted.some((context) => typeof context === 'string' && contexts.has(context)) &&
    (documentPatterns.length === 0 ||
      documentPatterns.some((p) => matchesUrlPattern(p, documentUrl))) &&
    (targetPatterns.length === 0 ||
      !targetUrl ||
      targetPatterns.some((p) => matchesUrlPattern(p, targetUrl)))
  )
}

function clickInfo(props: MenuProperties, params: Electron.ContextMenuParams, checked: boolean) {
  const frame = params.frame
  return {
    menuItemId: props.id,
    parentMenuItemId: props.parentId,
    mediaType: params.mediaType === 'none' ? undefined : params.mediaType,
    linkUrl: params.linkURL || undefined,
    srcUrl: params.srcURL || undefined,
    pageUrl: params.pageURL,
    frameUrl: params.frameURL || undefined,
    frameId: frame ? extensionFrameId(frame) : 0,
    selectionText: params.selectionText || undefined,
    editable: params.isEditable,
    wasChecked: props.checked === true,
    checked
  }
}

/** Where a menu opens: which entries show there, and the click info they report. */
type MenuSite = {
  shows: (props: MenuProperties, topLevel: boolean) => boolean
  info: (props: MenuProperties, checked: boolean) => Record<string, unknown>
}

function pageSite(params: Electron.ContextMenuParams): MenuSite {
  return {
    shows: (props) => applies(props, params),
    info: (props, checked) => clickInfo(props, params, checked)
  }
}

// Why separate: "all" covers page contexts only; toolbar entries must ask for "action" by name.
const ACTION_SITE: MenuSite = {
  shows: (props, topLevel) =>
    props.visible !== false &&
    (!topLevel ||
      [props.contexts]
        .flat()
        .some((context) => context === 'action' || context === 'browser_action')),
  info: (props, checked) => ({
    menuItemId: props.id,
    parentMenuItemId: props.parentId,
    editable: false,
    wasChecked: props.checked === true,
    checked
  })
}

function buildItems(
  tab: WebContents,
  extension: Electron.Extension,
  items: ItemsById,
  parentId: unknown,
  site: MenuSite,
  selectionText = ''
): MenuItem[] {
  return [...items.values()]
    .filter((props) => props.parentId === parentId && site.shows(props, parentId === undefined))
    .map((props) => {
      const type =
        props.type === 'checkbox' || props.type === 'radio' || props.type === 'separator'
          ? props.type
          : 'normal'
      const children = buildItems(tab, extension, items, props.id, site, selectionText)
      const title = String(props.title ?? '').replaceAll(
        '%s',
        selectionText.slice(0, SELECTION_TITLE_LIMIT)
      )
      return new MenuItem({
        type: children.length > 0 ? 'submenu' : type,
        label: title,
        enabled: props.enabled !== false,
        checked: props.checked === true,
        ...(children.length > 0 ? { submenu: Menu.buildFromTemplate(children) } : {}),
        click: () => {
          const checked = type === 'checkbox' ? props.checked !== true : type === 'radio'
          if (type === 'radio') {
            for (const sibling of items.values()) {
              if (sibling.type === 'radio' && sibling.parentId === props.parentId) {
                sibling.checked = false
              }
            }
          }
          const info = site.info(props, checked)
          if (type === 'checkbox' || type === 'radio') {
            props.checked = checked
          }
          emitExtensionEvent(
            tab.session,
            'contextMenus.onClicked',
            [info, tabDetails(tab, extension)],
            extension.id
          )
        }
      })
    })
}

/** The extension's chrome.contextMenus entries for its toolbar button. */
export function extensionActionMenuItems(
  tab: WebContents,
  extension: Electron.Extension
): MenuItem[] {
  const items = menusBySession.get(tab.session)?.get(extension.id)
  return items ? buildItems(tab, extension, items, undefined, ACTION_SITE) : []
}

function extensionIcon(extension: Electron.Extension): Electron.NativeImage | undefined {
  const icons = objectArg(extension.manifest.icons)
  const path = icons['16'] ?? icons['32'] ?? Object.values(icons)[0]
  return typeof path === 'string'
    ? nativeImage.createFromPath(join(extension.path, path)).resize({ width: 16, height: 16 })
    : undefined
}

/**
 * The page's chrome.contextMenus entries for this right-click, kept so a pick can run them. An
 * extension with several top-level entries gets one entry named after it, as in Chrome.
 */
export function getBrowserExtensionMenuItems(
  tab: WebContents,
  params: Electron.ContextMenuParams
): BrowserExtensionMenuItem[] {
  const shown: MenuItem[] = []
  for (const [extensionId, items] of menusBySession.get(tab.session) ?? []) {
    const extension = tab.session.extensions.getExtension(extensionId)
    const top = extension
      ? buildItems(tab, extension, items, undefined, pageSite(params), params.selectionText)
      : []
    if (!extension || top.length === 0) {
      continue
    }
    shown.push(
      top.length === 1
        ? top[0]
        : new MenuItem({
            label: extension.name,
            icon: extensionIcon(extension),
            submenu: Menu.buildFromTemplate(top)
          })
    )
  }
  shownByTab.set(tab, shown)
  return shown.flatMap((item, index) =>
    item.type === 'separator'
      ? []
      : [
          {
            index,
            label: item.label,
            enabled: item.enabled,
            hasSubmenu: item.submenu !== undefined,
            iconDataUrl: item.icon && typeof item.icon !== 'string' ? item.icon.toDataURL() : null
          }
        ]
  )
}

/** Runs a picked entry; one with children opens them as a native menu at the pointer. */
export function runBrowserExtensionMenuItem(
  tab: WebContents,
  index: number,
  window: Electron.BrowserWindow | null
): void {
  const item = shownByTab.get(tab)?.[index]
  if (!item?.enabled) {
    return
  }
  if (item.submenu) {
    item.submenu.popup(window ? { window } : {})
  } else {
    item.click()
  }
}
