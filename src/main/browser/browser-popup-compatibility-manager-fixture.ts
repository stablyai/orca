import type { WebContents } from 'electron'
import { BrowserManager } from './browser-manager'
import type { PopupChildWindowOptions } from './popup-origin-bar-window'
import { popupFixtureContentSecurity as contentSecurity } from './browser-popup-native-electron-fixture'

export class BrowserPopupCompatibilityManager extends BrowserManager {
  constructor(private readonly writeStatus: () => void) {
    super()
  }

  tabOpens: { url: string; activate: boolean | undefined }[] = []
  childRequests: {
    adopted: boolean
    native: boolean
    sessionMatches: boolean
    security: ReturnType<typeof contentSecurity>
    permission?: string
  }[] = []
  protected override openLinkInOrcaTab(pageId: string, url: string, activate?: boolean): boolean {
    this.tabOpens.push({ url, activate })
    this.writeStatus()
    return super.openLinkInOrcaTab(pageId, url, activate)
  }
  protected override createPopupChildWindowWithOriginBar(
    opener: WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions
  ): WebContents {
    const contents = super.createPopupChildWindowWithOriginBar(opener, targetUrl, options)
    const record = {
      adopted: Boolean(options.webContents),
      native: Boolean(options.nativeWindow),
      sessionMatches: contents.session === opener.session,
      security: contentSecurity(contents),
      permission: 'pending'
    }
    this.childRequests.push(record)
    if (!options.webContents) {
      contents.once('did-finish-load', () => {
        void contents
          .executeJavaScript('Notification.requestPermission()')
          .then((permission: unknown) => {
            record.permission = typeof permission === 'string' ? permission : 'unknown'
            this.writeStatus()
          })
          .catch(() => {
            record.permission = 'unavailable'
            this.writeStatus()
          })
      })
    }
    this.writeStatus()
    return contents
  }
}
