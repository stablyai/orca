import { EventEmitter } from 'node:events'
import { BrowserWindow, type WebContents } from 'electron'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { registerRendererDocumentNavigation } from '../../../window/renderer-document-navigation'
import {
  createPtyIpcSession,
  type PtyDataPayload,
  type NativePtyHint,
  type PtyIpcSession,
  type PtyRendererDelivery
} from '../session'
import { wirePtyIpcSession } from './wire-session'
import { resetPtyRendererDeliveryAccounting } from './accounting'
import { makePtyDataPayload } from './payload'
import { getDroppedMode2031RendererData, getDroppedSynchronizedOutputRendererData } from './pending'
import {
  activeRendererPtys,
  visibleRendererPtys,
  rendererVisibilityKnownPtys
} from './visibility-state'
import { setRendererPtyDeliveryInterest } from '../../pty-hidden-delivery-gate'

type NativeDelivery = {
  id: number
  renderer: WebContents
  window: BrowserWindow
  session: PtyIpcSession
  hints: Map<string, Partial<Record<NativePtyHint, boolean>>>
}

function payloadId(value: unknown): string | null {
  return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    ? value.id
    : null
}

export class NativeDesktopPtyDelivery {
  private readonly windows = new Map<number, NativeDelivery>()
  private readonly drivers = new Map<string, number>()
  private sourceSession: PtyIpcSession | null = null
  readonly source: PtyRendererDelivery

  constructor(
    private readonly runtime: Pick<OrcaRuntimeService, 'getPtyOutputSequence'>,
    private readonly settings: () => GlobalSettings
  ) {
    const lifecycle = new EventEmitter()
    this.source = {
      acceptsRenderer: (renderer) => this.sessionFor(renderer) !== null,
      isDestroyed: () => this.windows.size === 0,
      isFocused: () =>
        [...this.windows.values()].some(
          ({ window }) => !window.isDestroyed() && window.isFocused()
        ),
      isVisible: () =>
        [...this.windows.values()].some(
          ({ window }) => !window.isDestroyed() && window.isVisible()
        ),
      isMinimized: () =>
        [...this.windows.values()].every(
          ({ window }) => window.isDestroyed() || window.isMinimized()
        ),
      webContents: {
        id: -1,
        isDestroyed: () => this.windows.size === 0,
        send: (channel, ...values) => this.notice(channel, ...values),
        on: (...args) => lifecycle.on(...args),
        removeListener: (...args) => lifecycle.removeListener(...args)
      }
    }
  }

  add(window: BrowserWindow): void {
    const renderer = window.webContents
    const id = renderer.id
    if (this.windows.get(id)?.renderer === renderer) {
      return
    }
    const session = createPtyIpcSession({
      mainWindow: window,
      getSettings: this.settings,
      options: {
        rendererDeliveryOnly: true,
        outputSequenceOf: (ptyId) => this.runtime.getPtyOutputSequence(ptyId)
      }
    })
    wirePtyIpcSession(session)
    const entry: NativeDelivery = { id, renderer, window, session, hints: new Map() }
    this.windows.set(id, entry)
    registerRendererDocumentNavigation(renderer, () => {
      const ready = session.rendererPtyDispatcherReady
      const ptys = [...session.rendererDeliveryAccountingByPty.keys()]
      resetPtyRendererDeliveryAccounting(session, false)
      this.clearHints(entry)
      return () => {
        session.rendererPtyDispatcherReady = ready
        for (const ptyId of ptys) {
          session.sendModelRestoreNeededMarker(
            ptyId,
            'delivery-heal',
            this.runtime.getPtyOutputSequence(ptyId)
          )
        }
        session.schedulePendingDataFlush(0)
      }
    })
    renderer.on('render-process-gone', () => {
      resetPtyRendererDeliveryAccounting(session, false)
      this.clearHints(entry)
    })
    renderer.once('destroyed', () => {
      if (this.windows.get(id) !== entry) {
        return
      }
      this.windows.delete(id)
      this.clearHints(entry)
      resetPtyRendererDeliveryAccounting(session, false)
      if (session.flushTimer) {
        clearTimeout(session.flushTimer)
        session.flushTimer = null
      }
    })
  }

  attachSource(session: PtyIpcSession): void {
    this.sourceSession = session
  }

  claim(renderer: WebContents, id: string): void {
    if (this.sessionFor(renderer)) {
      this.drivers.set(id, renderer.id)
    }
  }

  canResize(renderer: WebContents, id: string): boolean {
    if (!this.sessionFor(renderer)) {
      return false
    }
    const driver = this.drivers.get(id)
    if (
      driver === undefined ||
      driver === renderer.id ||
      BrowserWindow.getFocusedWindow()?.webContents === renderer
    ) {
      this.claim(renderer, id)
      return true
    }
    return false
  }

  canReply(renderer: WebContents, id: string): boolean {
    if (!this.sessionFor(renderer)) {
      return false
    }
    if (!this.drivers.has(id)) {
      this.claim(renderer, id)
    }
    return this.drivers.get(id) === renderer.id
  }

  updateHint(renderer: WebContents, id: string, hint: NativePtyHint, value: boolean): boolean {
    const entry = this.windows.get(renderer.id)
    if (entry?.renderer !== renderer) {
      return value
    }
    entry.hints.set(id, { ...entry.hints.get(id), [hint]: value })
    return this.aggregateHint(id, hint)
  }

  private aggregateHint(id: string, hint: NativePtyHint): boolean {
    const hints = [...this.windows.values()].flatMap((entry) => {
      const state = entry.hints.get(id)
      return state ? [state] : []
    })
    return hint === 'hidden'
      ? !hints.some(
          (state) => state.hidden === false || state.visible === true || state.interest === true
        )
      : hints.some((state) => state[hint] === true)
  }

  private clearHints(entry: NativeDelivery): void {
    const ids = [...entry.hints.keys()]
    entry.hints.clear()
    for (const [id, driver] of this.drivers) {
      if (driver === entry.id) {
        this.drivers.delete(id)
      }
    }
    for (const id of ids) {
      for (const [hint, set] of [
        ['active', activeRendererPtys],
        ['visible', visibleRendererPtys]
      ] as const) {
        if (this.aggregateHint(id, hint)) {
          set.add(id)
        } else {
          set.delete(id)
        }
      }
      rendererVisibilityKnownPtys.add(id)
      setRendererPtyDeliveryInterest(id, this.aggregateHint(id, 'interest'))
      this.sourceSession?.transitionHiddenRendererPtyDeliveryState(
        id,
        this.aggregateHint(id, 'hidden')
      )
      this.sourceSession?.syncPtyBackgroundedDelivery(id, 'window-detach')
    }
  }

  sessionFor(renderer: WebContents): PtyIpcSession | null {
    if (renderer.isDestroyed()) {
      return null
    }
    const entry = this.windows.get(renderer.id)
    return entry?.renderer === renderer ? entry.session : null
  }

  acceptData(payload: PtyDataPayload): boolean {
    for (const { renderer, session } of this.windows.values()) {
      if (!renderer.isDestroyed()) {
        session.acceptPtyDataForRenderer(
          {
            id: payload.id,
            data: payload.data,
            sequenceChars: payload.rawLength,
            transformed: payload.transformed
          },
          payload.seq
        )
      }
    }
    return true
  }

  private notice(channel: string, ...values: unknown[]): void {
    const id = payloadId(values[0])
    if (channel === 'pty:serializeBuffer:request') {
      const value = values[0]
      const ptyId =
        value && typeof value === 'object' && 'ptyId' in value && typeof value.ptyId === 'string'
          ? value.ptyId
          : null
      const entries = [...this.windows.values()].filter((entry) => !entry.renderer.isDestroyed())
      const target =
        entries.find((entry) => ptyId && this.drivers.get(ptyId) === entry.id) ??
        entries.find((entry) => ptyId && entry.hints.get(ptyId)?.visible) ??
        entries.at(-1)
      target?.renderer.send(channel, ...values)
      return
    }
    for (const { renderer, session } of this.windows.values()) {
      if (renderer.isDestroyed()) {
        continue
      }
      if (id && (channel === 'pty:exit' || channel === 'pty:spawned')) {
        const pending = session.pendingData.delete(id)
        if (pending && channel === 'pty:exit') {
          session.sendPtyDataToRenderer(
            id,
            pending.droppedOutput
              ? {
                  id,
                  data:
                    pending.data +
                    getDroppedSynchronizedOutputRendererData(pending) +
                    getDroppedMode2031RendererData(pending),
                  droppedOutput: true
                }
              : makePtyDataPayload(
                  id,
                  pending.data,
                  pending.startSeq,
                  pending.containsBackgroundOutput,
                  pending.rawLength,
                  pending.transformed
                )
          )
        }
        session.rendererInFlightTotalChars = Math.max(
          0,
          session.rendererInFlightTotalChars - session.getRendererInFlightCharsForPty(id)
        )
        session.rendererDeliveryAccountingByPty.delete(id)
        session.pendingOverflowMarkedPtys.delete(id)
        session.rendererDeliveryRestoreNeededPtys.delete(id)
        session.schedulePendingDataAfterCreditReport(true)
      }
      try {
        renderer.send(channel, ...values)
      } catch {
        resetPtyRendererDeliveryAccounting(session, false)
      }
    }
  }
}
