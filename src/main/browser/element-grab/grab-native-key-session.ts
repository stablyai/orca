import { randomUUID } from 'node:crypto'
import { setBrowserInputPolicy, retireBrowserInputPolicy } from '../cdp/input/browser-input-guard'
import type { WebContents } from 'electron'
import {
  GRAB_NATIVE_KEY_POLICY,
  GRAB_NATIVE_KEY_REPORT
} from '../../../shared/browser/element-grab/browser-grab-native-keys'
import {
  isBrowserGuestToolKey,
  isBrowserGrabActionKey
} from '../../../shared/browser/element-grab/browser-grab-types'
import { registerAgentInputSuspension } from '../cdp/input/agent-input-injection'

/** One document and destination; preload acknowledgements never authorize a later session. */
export class GrabNativeKeySession {
  private readonly token = randomUUID()
  private revision = 0
  private enabled = false
  private stopped = false
  private pending: { revision: number; finish: (ready: boolean, retire?: boolean) => void } | null =
    null
  private readonly unregisterSuspension: () => void

  constructor(
    private readonly guest: WebContents,
    private readonly host: WebContents,
    private readonly pageId: string,
    private readonly onStopped: () => void = () => {},
    private readonly canDeliver: () => boolean = () => true,
    private readonly onUnavailable: () => void = () => {},
    private readonly paletteKeys = true
  ) {
    setBrowserInputPolicy(guest, 'native', this.token)
    host.on('destroyed', this.stop)
    host.on('did-start-navigation', this.onNavigation)
    guest.on('ipc-message', this.onReport)
    guest.on('destroyed', this.stop)
    guest.on('did-start-navigation', this.onNavigation)
    this.unregisterSuspension = registerAgentInputSuspension(guest, async (suspended) => {
      // Already live: republishing would bump the revision and drop a key the page reports meanwhile.
      if (!suspended && this.enabled && !this.pending) {
        return
      }
      if (!(await this.setEnabled(!suspended))) {
        throw new Error('Could not suspend browser tool shortcuts safely')
      }
    })
  }

  setEnabled(enabled: boolean): Promise<boolean> {
    if (this.stopped || this.guest.isDestroyed()) {
      return Promise.resolve(false)
    }
    this.pending?.finish(false, false)
    const revision = ++this.revision
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), 1_000)
      const finish = (ready: boolean, retire = true): void => {
        clearTimeout(timer)
        if (this.pending?.revision === revision) {
          this.pending = null
        }
        this.enabled = ready && enabled
        resolve(ready)
        if (!ready && retire && !this.stopped) {
          this.onUnavailable()
          this.stop()
        }
      }
      this.pending = { revision, finish }
      this.guest.send(GRAB_NATIVE_KEY_POLICY, {
        token: this.token,
        revision,
        enabled,
        paletteKeys: this.paletteKeys
      })
    })
  }

  private readonly onReport = (
    event: Electron.IpcMainEvent,
    channel: string,
    payload: unknown
  ): void => {
    if (
      this.stopped ||
      channel !== GRAB_NATIVE_KEY_REPORT ||
      event.senderFrame !== this.guest.mainFrame ||
      !payload ||
      typeof payload !== 'object' ||
      !('token' in payload) ||
      payload.token !== this.token ||
      !('revision' in payload) ||
      payload.revision !== this.revision
    ) {
      return
    }
    if (!this.canDeliver() || this.host.isDestroyed()) {
      this.stop()
      return
    }
    if ('ready' in payload && payload.ready === true) {
      this.pending?.finish(true)
      return
    }
    if (
      this.enabled &&
      'key' in payload &&
      typeof payload.key === 'string' &&
      isBrowserGuestToolKey(payload.key) &&
      (this.paletteKeys || isBrowserGrabActionKey(payload.key)) &&
      !this.host.isDestroyed()
    ) {
      this.host.send('browser:grabActionShortcut', { browserPageId: this.pageId, key: payload.key })
    }
  }

  private readonly onNavigation = (
    _event: unknown,
    _url: unknown,
    inPlace: boolean,
    mainFrame: boolean
  ): void => {
    if (mainFrame && !inPlace) {
      this.stop()
    }
  }

  readonly stop = (): void => {
    if (this.stopped) {
      return
    }
    this.stopped = true
    retireBrowserInputPolicy(this.guest, 'native', this.token)
    this.onStopped()
    this.enabled = false
    this.pending?.finish(false)
    this.unregisterSuspension()
    if (!this.guest.isDestroyed()) {
      this.guest.send(GRAB_NATIVE_KEY_POLICY, {
        token: this.token,
        revision: ++this.revision,
        enabled: false
      })
    }
    this.host.off('destroyed', this.stop)
    this.host.off('did-start-navigation', this.onNavigation)
    this.guest.off('ipc-message', this.onReport)
    this.guest.off('destroyed', this.stop)
    this.guest.off('did-start-navigation', this.onNavigation)
  }
}
