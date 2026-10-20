import { Notification, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getChromeExtensionOrigin } from '../../../../shared/browser-extension-url'
import { isBackgroundLaunch } from '../../../window/foreground-activation-policy'
import { emitBrowserExtensionEvent } from '../browser-extension-api-host'
import { resolveInsideExtensionDirectory } from '../browser-extension-manifest'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { noteBrowserExtensionUserGesture } from './permissions'

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

/** Profile → extension → notification id. Held so click handlers survive GC. */
const shownByProfile = new Map<string, Map<string, Map<string, Shown>>>()

function shownFor(caller: BrowserExtensionCaller): Map<string, Shown> {
  let byExtension = shownByProfile.get(caller.browserProfileId)
  if (!byExtension) {
    byExtension = new Map()
    shownByProfile.set(caller.browserProfileId, byExtension)
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
  const origin = getChromeExtensionOrigin(extension.id)
  let url: URL
  try {
    url = new URL(iconUrl, `${origin}/`)
  } catch {
    return null
  }
  if (url.origin !== origin) {
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

function detach(entry: Shown): void {
  const { notification } = entry
  entry.notification = null
  if (notification) {
    notification.removeAllListeners()
    notification.close()
  }
}

function show(caller: BrowserExtensionCaller, id: string, entry: Shown): void {
  // Why: background (test) launches must never put anything on the user's screen.
  if (!Notification.isSupported() || isBackgroundLaunch()) {
    return
  }
  const { options } = entry
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
    noteBrowserExtensionUserGesture(caller.session, caller.extension.id)
    emit(caller, 'onClicked', [id])
  })
  notification.on('action', (details) => {
    noteBrowserExtensionUserGesture(caller.session, caller.extension.id)
    emit(caller, 'onButtonClicked', [id, details.actionIndex])
  })
  notification.on('close', (details) => {
    shownFor(caller).delete(id)
    emit(caller, 'onClosed', [id, details.reason !== 'timedOut'])
  })
  entry.notification = notification
  notification.show()
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
