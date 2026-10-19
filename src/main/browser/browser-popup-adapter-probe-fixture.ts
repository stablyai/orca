import { app, BrowserWindow, type Session, type WebContents } from 'electron'
import { openPopupWithOriginBar, type PopupChildWindowOptions } from './popup-origin-bar-window'
import { allowNativeBrowserPopup } from './browser-popup-native-window'

export class BrowserPopupAdapterProbeFixture {
  readonly events: Record<string, unknown>[] = []
  private sequence = 0
  private readonly unrelatedWindows = new Set<BrowserWindow>()
  private readonly observedSessions = new WeakSet<Session>()
  private readonly observedContents = new Set<number>()

  constructor(private readonly writeStatus: () => void) {
    app.on('browser-window-created', (_event, window) => {
      this.record('browser-window-created', window.webContents)
    })
    app.on('web-contents-created', (_event, contents) => {
      this.record('web-contents-created', contents)
      contents.once('will-frame-navigate', () => this.record('will-frame-navigate', contents))
      contents.once('did-start-navigation', () => this.record('did-start-navigation', contents))
      contents.on('console-message', ({ message }) => {
        if (message.includes('Blocked form submission')) {
          this.record('sandbox-form-blocked', contents, { message })
        }
      })
    })
  }

  private record(event: string, contents: WebContents, extra: Record<string, unknown> = {}): void {
    const preferences =
      'getLastWebPreferences' in contents && typeof contents.getLastWebPreferences === 'function'
        ? contents.getLastWebPreferences()
        : null
    this.events.push({
      event,
      contentsId: contents.id,
      url: contents.getURL(),
      opener: contents.opener?.top?.url ?? null,
      frameName: contents.mainFrame.name,
      frameOrigin: contents.mainFrame.origin,
      preferences,
      ...extra
    })
    this.writeStatus()
  }

  install(guest: WebContents): void {
    if (!this.observedSessions.has(guest.session)) {
      this.observedSessions.add(guest.session)
      guest.session.webRequest.onBeforeRequest((details, callback) => {
        this.events.push({
          event: 'before-request',
          contentsId: details.webContentsId,
          url: details.url,
          observedBeforeRequest:
            details.webContentsId !== undefined && this.observedContents.has(details.webContentsId),
          webRtcPolicy: details.webContents?.getWebRTCIPHandlingPolicy()
        })
        this.writeStatus()
        callback({})
      })
    }
    let adopted = true
    let unrelatedDuringAdmission = false
    guest.on('console-message', ({ message }) => {
      if (message === 'orca-popup-fixture:probe-native') {
        adopted = false
      }
      if (message === 'orca-popup-fixture:probe-adopted') {
        adopted = true
      }
      if (message === 'orca-popup-fixture:probe-unrelated') {
        unrelatedDuringAdmission = true
      }
      if (message === 'orca-popup-fixture:snapshot') {
        this.writeStatus()
      }
      if (message === 'orca-popup-fixture:probe-cleanup') {
        for (const window of this.unrelatedWindows) {
          if (!window.isDestroyed()) {
            window.destroy()
          }
        }
        this.unrelatedWindows.clear()
      }
    })
    guest.on('did-create-window', (window, details) => {
      this.record('did-create-window', window.webContents, {
        owner: guest.id,
        optionsArguments: details.options.webPreferences?.additionalArguments,
        optionsPreferences: details.options.webPreferences
      })
    })
    guest.setWindowOpenHandler((details) => {
      const request = ++this.sequence
      this.events.push({ event: 'admission', request, owner: guest.id, details })
      this.writeStatus()
      if (unrelatedDuringAdmission) {
        unrelatedDuringAdmission = false
        const response = allowNativeBrowserPopup({
          opener: guest,
          targetUrl: details.url,
          options: { show: false },
          onCreated: ({ nativeWindow }) => {
            if (!nativeWindow) {
              throw new Error('Missing native child')
            }
            this.record('production-adapter-created', nativeWindow.webContents, {
              request,
              owner: guest.id
            })
            return nativeWindow.webContents
          }
        })
        const unrelated = new BrowserWindow({
          show: false,
          webPreferences: { session: guest.session }
        })
        this.unrelatedWindows.add(unrelated)
        this.record('unrelated-window', unrelated.webContents, { request })
        unrelated.webContents.once('destroyed', () =>
          this.events.push({ event: 'unrelated-destroyed', request })
        )
        return response
      }
      const options = {
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          session: guest.session,
          additionalArguments: [`--orca-popup-probe=${request}`]
        }
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: options,
        ...(adopted
          ? {
              createWindow: (childOptions: PopupChildWindowOptions) => {
                const child = childOptions.webContents
                if (child) {
                  this.record('createWindow', child, {
                    callbackRequest: request,
                    owner: guest.id,
                    optionsPreferences: childOptions.webPreferences
                  })
                } else {
                  this.events.push({
                    event: 'createWindow-missing',
                    request,
                    owner: guest.id,
                    optionsPreferences: childOptions.webPreferences
                  })
                }
                let contents: WebContents
                if (child) {
                  contents = openPopupWithOriginBar(
                    { ...childOptions, show: false },
                    details.url,
                    () => true
                  ).contentWebContents
                } else {
                  const window = new BrowserWindow({ ...childOptions, show: false })
                  this.unrelatedWindows.add(window)
                  contents = window.webContents
                }
                this.observe(contents, guest.id)
                this.writeStatus()
                return contents
              }
            }
          : {})
      }
    })
    // Observation only; native creation keeps Chromium's original navigation.
    guest.prependListener('did-create-window', (window) =>
      this.observe(window.webContents, guest.id)
    )
  }

  private observe(contents: WebContents, owner: number): void {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    this.observedContents.add(contents.id)
    this.record('observer-attached', contents, { owner })
    contents.once('did-start-navigation', () =>
      this.record('first-navigation', contents, { owner })
    )
    contents.once('did-finish-load', () => this.record('loaded', contents, { owner }))
  }
}
