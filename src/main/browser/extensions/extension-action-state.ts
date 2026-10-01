import { nativeImage, type Session, type WebContents } from 'electron'
import { isAbsolute, join, relative } from 'node:path'
import type { BrowserExtensionAction } from '../../../shared/browser-guest-events'
import { isWindowlessLaunch } from '../../window/foreground-activation-policy'
import { objectArg } from './extension-api-args'

/** What chrome.action can set, globally or for one tab. */
type ActionFields = {
  title?: string
  popup?: string
  iconDataUrl?: string | null
  badgeText?: string
  badgeBackgroundColor?: ColorArray
  badgeTextColor?: ColorArray
  enabled?: boolean
}
type ColorArray = [number, number, number, number]
type ActionState = { global: ActionFields; tabs: Map<number, ActionFields> }

const TOOLBAR_ICON_SIZE = 32
const statesBySession = new WeakMap<Session, Map<string, ActionState>>()
let changed: (session: Session) => void = () => {}

/** Called whenever an extension's toolbar button changes, so toolbars redraw. */
export function setExtensionActionsChangedListener(listener: (session: Session) => void): void {
  changed = listener
}

/** A window an extension opens: shown once its page paints, and never in a background run. */
export function presentExtensionWindow(window: Electron.BrowserWindow): void {
  window.once('ready-to-show', () => {
    if (!window.isDestroyed() && !isWindowlessLaunch()) {
      window.show()
    }
  })
}

/** The manifest's action, under either of its MV3 and MV2 names. */
export function manifestAction(extension: Electron.Extension): Record<string, unknown> | null {
  const action: unknown = extension.manifest.action ?? extension.manifest.browser_action
  return typeof action === 'object' && action !== null ? objectArg(action) : null
}

/** A file inside the extension; null for paths that climb out of it. */
export function extensionFile(extension: { path: string }, path: string): string | null {
  const file = join(extension.path, path)
  const inside = relative(extension.path, file)
  return inside.startsWith('..') || isAbsolute(inside) ? null : file
}

/** An icon from a path or a size → path map, picking the size nearest the toolbar's. */
export function extensionIconDataUrl(extension: { path: string }, icon: unknown): string | null {
  const paths = typeof icon === 'string' ? { [TOOLBAR_ICON_SIZE]: icon } : objectArg(icon)
  const sizes = Object.keys(paths)
    .map(Number)
    .filter((size) => Number.isFinite(size))
    .sort((a, b) => Math.abs(a - TOOLBAR_ICON_SIZE) - Math.abs(b - TOOLBAR_ICON_SIZE))
  const path = sizes.length > 0 ? paths[sizes[0]] : undefined
  const file = typeof path === 'string' ? extensionFile(extension, path) : null
  const image = file ? nativeImage.createFromPath(file) : null
  return image && !image.isEmpty() ? image.toDataURL() : null
}

function defaults(extension: Electron.Extension): ActionFields {
  const action = manifestAction(extension) ?? {}
  const icons = action.default_icon ?? extension.manifest.icons
  return {
    title: typeof action.default_title === 'string' ? action.default_title : extension.name,
    popup: typeof action.default_popup === 'string' ? action.default_popup : '',
    iconDataUrl: extensionIconDataUrl(extension, icons),
    badgeText: '',
    enabled: true
  }
}

function stateOf(session: Session, extension: Electron.Extension): ActionState {
  let states = statesBySession.get(session)
  if (!states) {
    states = new Map()
    statesBySession.set(session, states)
    session.extensions.on('extension-unloaded', (_event, unloaded) => states?.delete(unloaded.id))
  }
  let state = states.get(extension.id)
  if (!state) {
    state = { global: defaults(extension), tabs: new Map() }
    states.set(extension.id, state)
  }
  return state
}

/** The action's current value of `field` for `tabId`, falling back to the global one. */
export function readAction<K extends keyof ActionFields>(
  session: Session,
  extension: Electron.Extension,
  field: K,
  tabId: number | undefined
): ActionFields[K] {
  const state = stateOf(session, extension)
  const tabValue = tabId === undefined ? undefined : state.tabs.get(tabId)?.[field]
  return tabValue ?? state.global[field]
}

/** Sets fields for one tab, or globally when `tab` is undefined; a tab's values go with it. */
export function writeAction(
  session: Session,
  extension: Electron.Extension,
  tab: WebContents | undefined,
  fields: ActionFields
): void {
  const state = stateOf(session, extension)
  if (!tab) {
    Object.assign(state.global, fields)
  } else {
    const existing = state.tabs.get(tab.id)
    if (!existing) {
      tab.once('destroyed', () => state.tabs.delete(tab.id))
    }
    state.tabs.set(tab.id, { ...existing, ...fields })
  }
  changed(session)
}

/** Chrome's ColorArray from either form chrome.action accepts: [r,g,b,a] or a CSS hex string. */
export function parseBadgeColor(value: unknown): ColorArray {
  if (Array.isArray(value) && value.length >= 3 && value.every((n) => typeof n === 'number')) {
    return [value[0], value[1], value[2], value[3] ?? 255]
  }
  const hex = typeof value === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1] : null
  if (!hex) {
    throw new TypeError('A badge color is [r, g, b, a] or a #rgb / #rrggbb string')
  }
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  const channel = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16)
  return [channel(0), channel(2), channel(4), 255]
}

function cssColor(color: ColorArray | undefined): string | null {
  return color ? `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})` : null
}

/** The session's extensions with toolbar buttons, as they show for `tab`. */
export function listExtensionActions(tab: WebContents): BrowserExtensionAction[] {
  return tab.session.extensions
    .getAllExtensions()
    .filter((extension) => manifestAction(extension) !== null)
    .map((extension) => {
      const read = <K extends keyof ActionFields>(field: K) =>
        readAction(tab.session, extension, field, tab.id)
      return {
        extensionId: extension.id,
        name: extension.name,
        title: read('title') ?? extension.name,
        iconDataUrl: read('iconDataUrl') ?? null,
        badgeText: read('badgeText') ?? '',
        badgeBackgroundColor: cssColor(read('badgeBackgroundColor')),
        badgeTextColor: cssColor(read('badgeTextColor')),
        enabled: read('enabled') !== false
      }
    })
}
