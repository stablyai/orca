import { app } from 'electron'

type Navigation = { url: string; options: Electron.LoadURLOptions }
type PendingNavigation = Navigation & { event: Electron.Event }

/** Bind factory-owned intent during Electron's synchronous webview construction. */
export function browserGuestInitialNavigation(host: Electron.WebContents) {
  const pending = new Map<Electron.Session, PendingNavigation[]>()
  const captured = new Map<Electron.WebContents, { navigation: Navigation; dispose: () => void }>()
  const capture = (_event: Electron.Event, guest: Electron.WebContents): void => {
    if (guest.isDestroyed() || guest.getType() !== 'webview' || guest.hostWebContents !== host) {
      return
    }
    const stack = pending.get(guest.session)
    const index = stack?.findLastIndex((record) => !record.event.defaultPrevented) ?? -1
    if (!stack || index < 0) {
      return
    }
    const [navigation] = stack.splice(index, 1)
    if (stack.length === 0) {
      pending.delete(guest.session)
    }
    const dispose = (): void => {
      captured.delete(guest)
      guest.removeListener('destroyed', dispose)
      guest.removeListener('did-start-navigation', superseded)
    }
    const superseded = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
    ): void => {
      if (event.isMainFrame && !event.isSameDocument) {
        dispose()
      }
    }
    captured.set(guest, { navigation, dispose })
    guest.once('destroyed', dispose)
    guest.on('did-start-navigation', superseded)
  }
  app.on('web-contents-created', capture)
  host.once('destroyed', () => {
    app.removeListener('web-contents-created', capture)
    pending.clear()
    for (const record of captured.values()) {
      record.dispose()
    }
  })
  return {
    stage(event: Electron.Event, session: Electron.Session, navigation: Navigation): void {
      const record = { ...navigation, event }
      const stack = pending.get(session) ?? []
      stack.push(record)
      pending.set(session, stack)
      // Unclaimed construction/cancellation ends with this synchronous factory invocation.
      queueMicrotask(() => {
        const index = stack.indexOf(record)
        if (index !== -1) {
          stack.splice(index, 1)
        }
        if (pending.get(session) === stack && stack.length === 0) {
          pending.delete(session)
        }
      })
    },
    take(guest: Electron.WebContents): Navigation | undefined {
      const record = captured.get(guest)
      record?.dispose()
      return guest.isDestroyed() ? undefined : record?.navigation
    }
  }
}
