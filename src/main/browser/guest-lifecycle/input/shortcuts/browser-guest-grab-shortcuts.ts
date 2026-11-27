import { randomUUID } from 'node:crypto'
import {
  GRAB_CHORD_POLICY,
  GRAB_CHORD_REPORT
} from '../../../../../shared/browser/element-grab/browser-grab-native-keys'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import { getEffectiveKeybindingsForAction } from '../../../../../shared/keybindings/effective'
import type { KeybindingInput, KeybindingOverrides } from '../../../../../shared/keybindings/types'
import {
  isAgentInjectingInput,
  isAgentInjectingKeyboard,
  recoverBrowserInputGuard,
  registerAgentInputSuspension
} from '../../../cdp/input/agent-input-injection'
import {
  setBrowserInputPolicy,
  retireBrowserInputPolicy
} from '../../../cdp/input/browser-input-guard'
import type { ResolveRenderer } from '../../browser-guest-renderer-target'

type GrabShortcutBinding = {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  hasActiveGrabOp: (browserTabId: string) => boolean
  getKeybindings?: () => KeybindingOverrides | undefined
  isCurrentGuest?: () => boolean
}

const policies = new Set<GrabChordSession>()

/** Keybinding edits publish once; input never waits for an IPC round trip. */
export function refreshGrabShortcutPolicies(): void {
  for (const policy of policies) {
    policy.refresh()
  }
}

class GrabChordSession {
  private token = randomUUID()
  private revision = 0
  private enabled = false
  private stopped = false
  private navigating = false
  private refreshGeneration = 0
  private pending: { finish: (ready: boolean) => void } | null = null
  private readonly unregisterSuspension: () => void

  constructor(private readonly args: GrabShortcutBinding) {
    const guest = args.guest
    setBrowserInputPolicy(guest, 'chord', this.token)
    guest.on('ipc-message', this.report)
    guest.on('dom-ready', this.documentReady)
    guest.on('did-stop-loading', this.stoppedLoading)
    guest.on('did-start-navigation', this.navigation)
    guest.on('destroyed', this.stop)
    policies.add(this)
    this.unregisterSuspension = registerAgentInputSuspension(guest, async (suspended) => {
      // Already live: republishing would bump the revision and drop a chord the page reports meanwhile.
      if (!suspended && this.enabled && !this.pending && !this.navigating) {
        return
      }
      if (!(await this.publish(!suspended && !this.navigating))) {
        throw new Error('Could not suspend the browser grab chord safely')
      }
    })
    this.refresh()
  }

  private publish(enabled: boolean): Promise<boolean> {
    const { guest } = this.args
    if (this.stopped || guest.isDestroyed()) {
      return Promise.resolve(false)
    }
    this.pending?.finish(false)
    this.enabled = false
    const revision = ++this.revision
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), 1_000)
      const finish = (ready: boolean): void => {
        clearTimeout(timer)
        if (this.pending?.finish === finish) {
          this.pending = null
          this.enabled = ready && enabled
        }
        resolve(ready)
      }
      this.pending = { finish }
      try {
        guest.send(GRAB_CHORD_POLICY, {
          token: this.token,
          revision,
          enabled,
          bindings: getEffectiveKeybindingsForAction(
            'browser.grabElement',
            process.platform,
            this.args.getKeybindings?.()
          ),
          platform: process.platform
        })
      } catch {
        finish(false)
      }
    })
  }

  readonly refresh = (): void => {
    const generation = ++this.refreshGeneration
    void (async () => {
      const ready = await recoverBrowserInputGuard(this.args.guest)
      if (!this.stopped && generation === this.refreshGeneration) {
        await this.publish(ready && !this.navigating && !isAgentInjectingKeyboard(this.args.guest))
      }
    })()
  }

  private readonly documentReady = (): void => {
    this.navigating = false
    this.refresh()
  }

  private readonly stoppedLoading = (): void => {
    if (this.navigating && !this.args.guest.isLoadingMainFrame()) {
      this.documentReady()
    }
  }

  private readonly navigation = (
    _event: unknown,
    _url: unknown,
    inPlace: boolean,
    main: boolean
  ): void => {
    if (main && !inPlace) {
      this.refreshGeneration += 1
      this.navigating = true
      this.token = randomUUID()
      setBrowserInputPolicy(this.args.guest, 'chord', this.token)
      void this.publish(false)
    }
  }

  private readonly report = (
    event: Electron.IpcMainEvent,
    channel: string,
    payload: { token?: string; revision?: number; ready?: boolean; input?: KeybindingInput }
  ): void => {
    const { guest, browserTabId, resolveRenderer, isCurrentGuest, getKeybindings } = this.args
    if (
      this.stopped ||
      channel !== GRAB_CHORD_REPORT ||
      !payload ||
      event.senderFrame !== guest.mainFrame ||
      payload.token !== this.token ||
      payload.revision !== this.revision
    ) {
      return
    }
    if (payload.ready === true) {
      this.pending?.finish(true)
      return
    }
    const renderer = resolveRenderer(browserTabId)
    if (
      this.enabled &&
      !this.navigating &&
      payload.input &&
      !isAgentInjectingInput(guest) &&
      isCurrentGuest?.() !== false &&
      renderer &&
      !renderer.isDestroyed() &&
      keybindingMatchesAction(
        'browser.grabElement',
        payload.input,
        process.platform,
        getKeybindings?.()
      )
    ) {
      renderer.send('browser:grabModeToggle', browserTabId, 'copy')
    }
  }

  readonly stop = (): void => {
    if (this.stopped) {
      return
    }
    this.stopped = true
    this.refreshGeneration += 1
    retireBrowserInputPolicy(this.args.guest, 'chord', this.token)
    this.enabled = false
    this.pending?.finish(false)
    this.unregisterSuspension()
    policies.delete(this)
    const guest = this.args.guest
    if (!guest.isDestroyed()) {
      guest.send(GRAB_CHORD_POLICY, {
        token: this.token,
        revision: ++this.revision,
        enabled: false,
        bindings: [],
        platform: process.platform
      })
    }
    guest.off('ipc-message', this.report)
    guest.off('dom-ready', this.documentReady)
    guest.off('did-stop-loading', this.stoppedLoading)
    guest.off('did-start-navigation', this.navigation)
    guest.off('destroyed', this.stop)
  }
}

/** The private preload cancels an eligible chord synchronously; main fences its eventual delivery. */
export function setupGrabShortcutForwarding(args: GrabShortcutBinding): () => void {
  const { browserTabId, guest, resolveRenderer, hasActiveGrabOp } = args
  const chord = new GrabChordSession(args)
  const handler = (_event: Electron.Event, input: Electron.Input): void => {
    if (isAgentInjectingInput(guest)) {
      return
    }
    if (input.key === 'Alt' && !input.isAutoRepeat) {
      if (input.type === 'keyUp' || hasActiveGrabOp(browserTabId)) {
        resolveRenderer(browserTabId)?.send('browser:grabActionShortcut', {
          browserPageId: browserTabId,
          key: input.type === 'keyDown' ? 'alt-down' : 'alt-up'
        })
      }
    }
  }
  guest.on('before-input-event', handler)
  return () => {
    chord.stop()
    guest.off('before-input-event', handler)
  }
}
