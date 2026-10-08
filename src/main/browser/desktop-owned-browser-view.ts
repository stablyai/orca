import type { View } from 'electron'
import { browserCaptureIdle, type BrowserCaptureReservation } from './browser-capture-idle'
import {
  isDesktopOwnedBrowserViewRecord,
  type DesktopOwnedBrowserViewRecord
} from './desktop-owned-browser-view-admission'

export type DesktopOwnedBrowserViewHost = {
  isDestroyed: () => boolean
  contentView: Pick<View, 'children' | 'addChildView' | 'removeChildView'>
}

export class DesktopOwnedBrowserView {
  private host: DesktopOwnedBrowserViewHost
  private closed = false
  private closing = false
  private closePromise: Promise<void> | null = null
  private retainedReservation: BrowserCaptureReservation | null = null
  private lifecycleQueue: Promise<void> = Promise.resolve()

  constructor(
    readonly record: DesktopOwnedBrowserViewRecord,
    initialHost: DesktopOwnedBrowserViewHost
  ) {
    this.host = initialHost
    this.assertAttached()
  }

  validate(browserPageId: string, rendererWebContentsId: number, generation: string): boolean {
    return (
      !this.closed &&
      !this.closing &&
      this.record.browserPageId === browserPageId &&
      this.record.rendererWebContentsId === rendererWebContentsId &&
      this.record.generation === generation &&
      this.hasRetainedIdentity() &&
      !this.host.isDestroyed() &&
      this.host.contentView.children.includes(this.record.view)
    )
  }

  updateLayout(bounds: Electron.Rectangle, visible: boolean): Promise<void> {
    return this.withStableView(() => {
      this.record.view.setBounds(bounds)
      this.record.view.setVisible(visible)
    })
  }

  withStableView<T>(
    operation: (reservation: BrowserCaptureReservation) => T | Promise<T>,
    afterIdle?: (reservation: BrowserCaptureReservation) => Promise<void>
  ): Promise<T> {
    this.assertAccepting()
    return this.enqueue(async () => {
      if (this.retainedReservation) {
        throw new Error('Desktop-owned browser view is fenced after failed capture restoration')
      }
      const reservation = await browserCaptureIdle.reserve(this.record.webContents)
      let operationOutcome: PromiseSettledResult<T>
      let afterIdleOutcome: PromiseSettledResult<void> | null = null
      try {
        try {
          operationOutcome = {
            status: 'fulfilled',
            value: await browserCaptureIdle.runReservedCapture(
              this.record.webContents,
              reservation,
              async () => {
                this.assertAttached()
                return operation(reservation)
              }
            )
          }
        } catch (reason) {
          operationOutcome = { status: 'rejected', reason }
        }

        await browserCaptureIdle.waitForIdle(this.record.webContents)
        if (afterIdle) {
          try {
            await browserCaptureIdle.runReservedCapture(
              this.record.webContents,
              reservation,
              async () => afterIdle(reservation)
            )
            afterIdleOutcome = { status: 'fulfilled', value: undefined }
          } catch (reason) {
            afterIdleOutcome = { status: 'rejected', reason }
          }
          await browserCaptureIdle.waitForIdle(this.record.webContents)
        }
      } finally {
        if (afterIdleOutcome?.status === 'rejected') {
          // Failed restoration fences reuse; close may settle and destroy this exact guest.
          this.retainedReservation = reservation
        } else {
          reservation.release()
        }
      }
      if (operationOutcome.status === 'rejected') {
        throw operationOutcome.reason
      }
      if (afterIdleOutcome?.status === 'rejected') {
        throw afterIdleOutcome.reason
      }
      return operationOutcome.value
    })
  }

  close(beforeDestroy?: () => Promise<void>): Promise<void> {
    if (!this.closePromise) {
      this.closing = true
      this.closePromise = this.enqueue(() => this.closeOnce(beforeDestroy))
      void this.closePromise.catch(() => {
        this.closePromise = null
      })
    }
    return this.closePromise
  }

  private hasRetainedIdentity(): boolean {
    return (
      isDesktopOwnedBrowserViewRecord(this.record) &&
      !this.record.webContents.isDestroyed() &&
      this.record.view.webContents === this.record.webContents &&
      this.record.webContents.session === this.record.session
    )
  }

  private assertAttached(): void {
    if (
      this.closed ||
      !this.hasRetainedIdentity() ||
      this.host.isDestroyed() ||
      !this.host.contentView.children.includes(this.record.view)
    ) {
      throw new Error('Desktop-owned browser view has lost its owned attachment')
    }
  }

  private assertAccepting(): void {
    if (this.closed || this.closing) {
      throw new Error('Desktop-owned browser view is closed')
    }
    this.assertAttached()
    if (this.retainedReservation) {
      throw new Error('Desktop-owned browser view is fenced after failed capture restoration')
    }
  }

  private detach(): void {
    if (!this.host.isDestroyed() && this.host.contentView.children.includes(this.record.view)) {
      this.host.contentView.removeChildView(this.record.view)
    }
  }

  private async closeOnce(beforeDestroy?: () => Promise<void>): Promise<void> {
    await browserCaptureIdle.waitForIdle(this.record.webContents)
    const reservation =
      this.retainedReservation ?? (await browserCaptureIdle.reserve(this.record.webContents))
    this.retainedReservation = reservation
    await beforeDestroy?.()
    this.detach()
    if (!this.record.webContents.isDestroyed()) {
      await new Promise<void>((resolve, reject) => {
        const destroyed = (): void => resolve()
        this.record.webContents.once('destroyed', destroyed)
        try {
          this.record.webContents.close()
        } catch (error) {
          this.record.webContents.removeListener('destroyed', destroyed)
          reject(error)
        }
      })
    }
    await browserCaptureIdle.waitForIdle(this.record.webContents)
    reservation.release()
    this.retainedReservation = null
    this.closed = true
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.lifecycleQueue.then(operation)
    this.lifecycleQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}
