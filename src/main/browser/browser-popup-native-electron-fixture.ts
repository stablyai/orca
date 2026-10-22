import {
  app,
  BaseWindow,
  session,
  type BrowserWindow,
  type Session,
  type WebContents
} from 'electron'
import { resolveBrowserRouteGuestPopupOpener } from './browser-route-guest-popup-ownership'

export class BrowserPopupNativeFixture {
  readonly presentationCalls: string[] = []
  readonly requests: { disposition: string; frameName: string; features: string; post: boolean }[] =
    []
  readonly creation: {
    contentsId: number
    firstNavigationPolicy?: string
    firstNavigationOwner?: number | null
    firstNavigationTitle?: string
  }[] = []
  private readonly windows: BrowserWindow[] = []
  private failCreation: 'authority' | 'authority-error' | 'webrtc' | 'close' | null = null

  constructor(
    private readonly input: {
      routeSession: () => Session | null
      failAuthority: (throwOnRead: boolean) => void
      restoreAuthority: () => void
      writeStatus: () => void
    }
  ) {
    for (const method of ['show', 'showInactive', 'focus', 'moveTop'] as const) {
      BaseWindow.prototype[method] = () => {
        this.presentationCalls.push(method)
        throw new Error(`Hidden popup fixture attempted ${method}`)
      }
    }
    app.focus = () => {
      this.presentationCalls.push('app.focus')
      throw new Error('Hidden popup fixture attempted app.focus')
    }
    app.on('web-contents-created', (_event, contents) => {
      if (
        !this.failCreation ||
        contents.session !== input.routeSession() ||
        contents.getType() !== 'window'
      ) {
        return
      }
      if (this.failCreation === 'authority' || this.failCreation === 'authority-error') {
        input.failAuthority(this.failCreation === 'authority-error')
      } else {
        if (this.failCreation === 'close') {
          contents.close = () => {
            throw new Error('Synthetic close failure')
          }
        }
        contents.setWebRTCIPHandlingPolicy = () => {
          throw new Error('Synthetic WebRTC failure')
        }
      }
      this.failCreation = null
    })
    app.on('browser-window-created', (_event, window) => {
      if (!input.routeSession() || window.webContents.session === session.defaultSession) {
        return
      }
      this.windows.push(window)
      window.once('closed', () => input.writeStatus())
      const record: (typeof this.creation)[number] = { contentsId: window.webContents.id }
      this.creation.push(record)
      window.webContents.once('did-start-navigation', () => {
        record.firstNavigationPolicy = window.webContents.getWebRTCIPHandlingPolicy()
        record.firstNavigationOwner = resolveBrowserRouteGuestPopupOpener(window.webContents.id)
        record.firstNavigationTitle = window.getTitle()
        input.writeStatus()
      })
    })
  }

  installControlHandler(guest: WebContents): void {
    guest.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: {
          session: guest.session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      }
    }))
  }

  trackRequests(guest: WebContents): void {
    const setWindowOpenHandler = guest.setWindowOpenHandler.bind(guest)
    guest.setWindowOpenHandler = (handler) =>
      setWindowOpenHandler((details) => {
        this.requests.push({
          disposition: details.disposition,
          frameName: details.frameName,
          features: details.features,
          post: Boolean(details.postBody)
        })
        this.input.writeStatus()
        return handler(details)
      })
  }

  handleMessage(message: string): void {
    if (message === 'orca-popup-fixture:fail-authority') {
      this.failCreation = 'authority'
    } else if (message === 'orca-popup-fixture:fail-webrtc') {
      this.failCreation = 'webrtc'
    } else if (message === 'orca-popup-fixture:fail-close') {
      this.failCreation = 'close'
    } else if (message === 'orca-popup-fixture:fail-authority-error') {
      this.failCreation = 'authority-error'
    } else if (message === 'orca-popup-fixture:restore-authority') {
      this.input.restoreAuthority()
    }
  }

  snapshot() {
    return {
      presentationCalls: this.presentationCalls,
      requests: this.requests,
      creation: this.creation,
      windows: this.windows.map((window) => ({
        closed: window.isDestroyed(),
        title: window.isDestroyed() ? '' : window.getTitle(),
        fullscreen: !window.isDestroyed() && window.isFullScreen(),
        focused: !window.isDestroyed() && window.isFocused(),
        contentSize: window.isDestroyed() ? [] : window.getContentSize()
      }))
    }
  }
}

export function popupFixtureContentSecurity(contents: WebContents): {
  sandbox: boolean | undefined
  contextIsolation: boolean | undefined
  nodeIntegration: boolean | undefined
} {
  if (
    !('getLastWebPreferences' in contents) ||
    typeof contents.getLastWebPreferences !== 'function'
  ) {
    throw new Error('Electron cannot report popup security preferences')
  }
  const preferences: unknown = contents.getLastWebPreferences()
  if (
    typeof preferences !== 'object' ||
    preferences === null ||
    !('sandbox' in preferences) ||
    !('contextIsolation' in preferences) ||
    !('nodeIntegration' in preferences)
  ) {
    throw new Error('Electron returned incomplete popup security preferences')
  }
  return {
    sandbox: typeof preferences.sandbox === 'boolean' ? preferences.sandbox : undefined,
    contextIsolation:
      typeof preferences.contextIsolation === 'boolean' ? preferences.contextIsolation : undefined,
    nodeIntegration:
      typeof preferences.nodeIntegration === 'boolean' ? preferences.nodeIntegration : undefined
  }
}
