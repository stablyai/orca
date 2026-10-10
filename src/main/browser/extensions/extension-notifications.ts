import { nativeImage, Notification } from 'electron'
import { isBackgroundLaunch } from '../../window/foreground-activation-policy'
import { emitExtensionEvent, handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import { objectArg, optionalString } from './extension-api-args'
import { extensionFile } from './extension-action-state'

type Shown = { notification: Notification; options: Record<string, unknown> }

// Keyed by extension id, then notification id.
const shownByExtension = new Map<string, Map<string, Shown>>()

function shownOf(extensionId: string): Map<string, Shown> {
  const shown = shownByExtension.get(extensionId) ?? new Map<string, Shown>()
  shownByExtension.set(extensionId, shown)
  return shown
}

function iconOf(caller: ExtensionCaller, iconUrl: unknown): Electron.NativeImage | undefined {
  if (typeof iconUrl !== 'string') {
    return undefined
  }
  if (iconUrl.startsWith('data:')) {
    return nativeImage.createFromDataURL(iconUrl)
  }
  const url = new URL(iconUrl, caller.extension.url)
  // Only the extension's own files; a remote icon would need a fetch Chrome does in the background.
  const file =
    url.origin === new URL(caller.extension.url).origin
      ? extensionFile(caller.extension, decodeURIComponent(url.pathname))
      : null
  return file ? nativeImage.createFromPath(file) : undefined
}

function show(caller: ExtensionCaller, id: string, options: Record<string, unknown>): void {
  const shown = shownOf(caller.extension.id)
  shown.get(id)?.notification.close()
  const buttons = Array.isArray(options.buttons) ? options.buttons : []
  const notification = new Notification({
    title: optionalString(options.title) ?? caller.extension.name,
    body: optionalString(options.message) ?? '',
    icon: iconOf(caller, options.iconUrl),
    silent: options.silent === true,
    actions: buttons.map((button) => ({
      type: 'button' as const,
      text: optionalString(objectArg(button).title) ?? ''
    }))
  })
  const emit = (event: string, ...args: unknown[]) =>
    emitExtensionEvent(caller.session, `notifications.${event}`, [id, ...args], caller.extension.id)
  notification.on('click', () => emit('onClicked'))
  notification.on('action', (_event, index) => emit('onButtonClicked', index))
  notification.on('close', () => {
    if (shown.get(id)?.notification === notification) {
      shown.delete(id)
      emit('onClosed', true)
    }
  })
  shown.set(id, { notification, options })
  // Why: automated runs must not put notifications on the developer's desktop.
  if (!isBackgroundLaunch()) {
    notification.show()
  }
}

handleExtensionApi('notifications', {
  create: (caller: ExtensionCaller, first: unknown, second: unknown) => {
    // create(id?, options): without an id Chrome makes one up.
    const hasId = typeof first === 'string'
    const id = hasId && first ? first : `orca-${Date.now()}-${Math.random()}`
    show(caller, id, objectArg(hasId ? second : first))
    return id
  },
  update: (caller: ExtensionCaller, id: unknown, options: unknown) => {
    const existing = typeof id === 'string' ? shownOf(caller.extension.id).get(id) : undefined
    if (!existing || typeof id !== 'string') {
      return false
    }
    show(caller, id, { ...existing.options, ...objectArg(options) })
    return true
  },
  clear: (caller: ExtensionCaller, id: unknown) => {
    const shown = shownOf(caller.extension.id)
    const existing = typeof id === 'string' ? shown.get(id) : undefined
    if (!existing || typeof id !== 'string') {
      return false
    }
    shown.delete(id)
    existing.notification.close()
    return true
  },
  getAll: (caller: ExtensionCaller) =>
    Object.fromEntries([...shownOf(caller.extension.id).keys()].map((id) => [id, true])),
  getPermissionLevel: () => (Notification.isSupported() ? 'granted' : 'denied')
})
