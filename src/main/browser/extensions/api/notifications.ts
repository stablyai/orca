import { isBrowserExtensionSuspension } from '../profile-sessions/browser-extension-worker-registration'
import { Notification, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  getChromeExtensionOrigin,
  parseChromeExtensionUrl
} from '../../../../shared/browser/extensions/browser-extension-url'
import { isBackgroundLaunch } from '../../../window/activation/foreground-activation-policy'
import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import { resolveInsideExtensionDirectory } from '../installation/browser-extension-manifest'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import { dispatchBrowserExtensionNotificationInteraction } from './browser-extension-notification-interactions'

const optionsSchema = z
  .object({
    type: z.enum(['basic', 'image', 'list', 'progress']),
    iconUrl: z.string(),
    title: z.string(),
    message: z.string(),
    contextMessage: z.string(),
    buttons: z.array(z.object({ title: z.string() }).loose()).max(2),
    requireInteraction: z.boolean(),
    silent: z.boolean(),
    priority: z.number().int()
  })
  .partial()
  .loose()

type NotificationOptions = z.infer<typeof optionsSchema>

type Shown = {
  options: NotificationOptions
  notification: Electron.Notification | null
}

/** Session → extension → notification id. Held so click handlers survive GC. */
const shownBySession = new WeakMap<Electron.Session, Map<string, Map<string, Shown>>>()

export function forgetBrowserExtensionNotifications(
  session: Electron.Session,
  extensionId: string
): void {
  const shown = shownBySession.get(session)?.get(extensionId)
  shownBySession.get(session)?.delete(extensionId)
  for (const entry of shown?.values() ?? []) {
    detach(entry)
  }
}

function shownFor(caller: BrowserExtensionCaller): Map<string, Shown> {
  let byExtension = shownBySession.get(caller.session)
  if (!byExtension) {
    byExtension = new Map()
    shownBySession.set(caller.session, byExtension)
    caller.session.extensions.on('extension-unloaded', (_event, extension) => {
      if (isBrowserExtensionSuspension(caller.session, extension)) {
        return
      }
      forgetBrowserExtensionNotifications(caller.session, extension.id)
    })
  }
  let shown = byExtension.get(caller.extension.id)
  if (!shown) {
    shown = new Map()
    byExtension.set(caller.extension.id, shown)
  }
  return shown
}

/** Why: icons come only from the extension's own package, never the web or other extensions. */
export function resolveNotificationIconPath(
  extension: Pick<Electron.Extension, 'id' | 'path'>,
  iconUrl: string | undefined
): string | null {
  if (!iconUrl) {
    return null
  }
  let url: URL
  try {
    url = new URL(iconUrl, `${getChromeExtensionOrigin(extension.id)}/`)
  } catch {
    return null
  }
  // Why not url.origin: Node reports "null" for chrome-extension: URLs.
  if (parseChromeExtensionUrl(url.toString())?.extensionId !== extension.id) {
    return null
  }
  return resolveInsideExtensionDirectory(extension.path, decodeURIComponent(url.pathname))
}

function emit(caller: BrowserExtensionCaller, event: string, args: unknown[]): void {
  emitBrowserExtensionEvent(
    { session: caller.session, extensionId: caller.extension.id },
    'notifications',
    event,
    args
  )
}

function detach(entry: Shown, closeNative = true): void {
  const { notification } = entry
  entry.notification = null
  if (notification) {
    notification.removeAllListeners()
    if (closeNative) {
      notification.close()
    }
  }
}

function interact(caller: BrowserExtensionCaller, event: string, args: unknown[]): void {
  void dispatchBrowserExtensionNotificationInteraction(
    caller.session,
    caller.extension.id,
    event,
    args
  ).catch((error: unknown) =>
    console.warn('[browser-extensions] Notification delivery failed:', error)
  )
}

function show(caller: BrowserExtensionCaller, id: string, entry: Shown): void {
  if (!Notification.isSupported()) {
    return
  }
  const { options } = entry
  const shown = shownFor(caller)
  const iconPath = resolveNotificationIconPath(caller.extension, options.iconUrl)
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
  const notification = new Notification({
    title: options.title ?? '',
    body: [options.message, options.contextMessage].filter(Boolean).join('\n'),
    silent: options.silent === true,
    timeoutType: options.requireInteraction ? 'never' : 'default',
    ...(icon && !icon.isEmpty() ? { icon } : {}),
    // Notification buttons exist only on macOS; elsewhere the body click still reaches the extension.
    ...(process.platform === 'darwin' && options.buttons?.length
      ? {
          actions: options.buttons.map((button) => ({
            type: 'button' as const,
            text: button.title
          }))
        }
      : {})
  })
  notification.on('click', () => {
    shown.delete(id)
    detach(entry, false)
    interact(caller, 'onClicked', [id])
  })
  notification.on('action', (details) => {
    interact(caller, 'onButtonClicked', [id, details.actionIndex])
  })
  notification.on('close', (details) => {
    shown.delete(id)
    detach(entry, false)
    if (caller.session.extensions.getExtension(caller.extension.id)) {
      emit(caller, 'onClosed', [id, details.reason !== 'timedOut'])
    }
  })
  notification.once('failed', () => {
    shown.delete(id)
    // Electron destroys the native notification after dispatching this failure.
    detach(entry, false)
  })
  entry.notification = notification
  // Background copies retain callbacks without posting anything on the user's desktop.
  if (!isBackgroundLaunch()) {
    notification.show()
  }
}

function create(caller: BrowserExtensionCaller, id: string, options: NotificationOptions): string {
  if (!options.type || options.title === undefined || options.message === undefined) {
    throw new BrowserExtensionApiError(
      'Some of the required properties are missing: type, title and message.'
    )
  }
  const notificationId = id || randomUUID()
  const shown = shownFor(caller)
  const previous = shown.get(notificationId)
  if (previous) {
    detach(previous)
  }
  const entry: Shown = { options, notification: null }
  shown.set(notificationId, entry)
  show(caller, notificationId, entry)
  return notificationId
}

export function registerNotificationsNamespace(): void {
  registerBrowserExtensionNamespace('notifications', {
    permission: 'notifications',
    methods: {
      create: defineBrowserExtensionMethod(
        z.union([z.tuple([optionsSchema]), z.tuple([z.string(), optionsSchema])]),
        (caller, ...args) =>
          args.length === 2 ? create(caller, args[0], args[1]) : create(caller, '', args[0])
      ),
      update: defineBrowserExtensionMethod(
        z.tuple([z.string(), optionsSchema]),
        (caller, id, options) => {
          const entry = shownFor(caller).get(id)
          if (!entry) {
            return false
          }
          detach(entry)
          entry.options = { ...entry.options, ...options }
          show(caller, id, entry)
          return true
        }
      ),
      clear: defineBrowserExtensionMethod(z.tuple([z.string()]), (caller, id) => {
        const shown = shownFor(caller)
        const entry = shown.get(id)
        if (!entry) {
          return false
        }
        shown.delete(id)
        detach(entry)
        emit(caller, 'onClosed', [id, false])
        return true
      }),
      getAll: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        Object.fromEntries([...shownFor(caller).keys()].map((id) => [id, true]))
      ),
      getPermissionLevel: defineBrowserExtensionMethod(z.tuple([]), () =>
        Notification.isSupported() ? 'granted' : 'denied'
      )
    },
    events: ['onClicked', 'onButtonClicked', 'onClosed', 'onPermissionLevelChanged']
  })
}
