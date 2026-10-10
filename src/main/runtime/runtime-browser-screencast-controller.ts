import type { BrowserScreencastResult, RuntimeBrowserDriverState } from '../../shared/runtime-types'
import { BrowserError } from '../browser/browser-error'
import {
  resolveBrowserDriverAfterMobileRelease,
  screencastSubscriberDrivesAsMobile,
  type BrowserScreencastSubscriber
} from './browser-screencast-driver-scope'
import type { RuntimeBrowserCommands } from './orca-runtime-browser'

type RuntimeBrowserScreencastControllerDeps = {
  getCommands: () => RuntimeBrowserCommands
  registerSubscriptionCleanup: (
    subscriptionId: string,
    cleanup: () => void | Promise<void>,
    connectionId?: string
  ) => void
  cleanupSubscription: (subscriptionId: string) => void
  getDriver: (browserPageId: string) => RuntimeBrowserDriverState
  setDriver: (browserPageId: string, next: RuntimeBrowserDriverState) => void
  notifyRemoteViewersChanged: (browserPageId: string, hasRemoteViewers: boolean) => void
}

export class RuntimeBrowserScreencastController {
  private readonly activeByConnection = new Map<
    string,
    Omit<BrowserScreencastSubscriber, 'drivesAsMobile'>
  >()
  private readonly activeByPage = new Map<string, Set<BrowserScreencastSubscriber>>()
  private readonly remoteViewerPages = new Set<string>()

  constructor(private readonly deps: RuntimeBrowserScreencastControllerDeps) {}

  cancelMobilePage(browserPageId: string, emitEnd = false): void {
    for (const stream of this.activeByPage.get(browserPageId) ?? []) {
      if (stream.drivesAsMobile) {
        stream.cancel(emitEnd)
      }
    }
  }

  getRemoteViewerPages(): string[] {
    return Array.from(this.remoteViewerPages)
  }

  private publishRemoteViewers(browserPageId: string): void {
    const watched = (this.activeByPage.get(browserPageId)?.size ?? 0) > 0
    if (this.remoteViewerPages.has(browserPageId) === watched) {
      return
    }
    if (watched) {
      this.remoteViewerPages.add(browserPageId)
    } else {
      this.remoteViewerPages.delete(browserPageId)
    }
    this.deps.notifyRemoteViewersChanged(browserPageId, watched)
  }

  async start(
    params: Parameters<RuntimeBrowserCommands['browserScreencast']>[0],
    options: {
      connectionId?: string
      pairedDeviceId?: string
      clientKind?: 'mobile' | 'runtime'
      sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
      signal?: AbortSignal
      emit: (result: BrowserScreencastResult) => void
    }
  ): Promise<void> {
    if (!options.sendBinary) {
      throw new BrowserError(
        'browser_error',
        'Browser screencast requires a binary streaming transport.'
      )
    }

    const connectionKey = options.connectionId ?? 'local'
    const drivesAsMobile = screencastSubscriberDrivesAsMobile(options.clientKind)
    let existingStream = this.activeByConnection.get(connectionKey)
    while (existingStream) {
      existingStream.cancel()
      await existingStream.done
      existingStream = this.activeByConnection.get(connectionKey)
    }
    if (options.signal?.aborted) {
      throw new BrowserError('browser_error', 'Browser screencast was cancelled.')
    }

    let screencast: Awaited<ReturnType<RuntimeBrowserCommands['browserScreencast']>> | null = null
    let registeredSubscriptionId: string | null = null
    let activeBrowserPageId: string | null = null
    let activePageStream: BrowserScreencastSubscriber | null = null
    let ended = false
    let cancelledBeforeStart = false
    let readyEmitted = false
    let resolveActiveDone!: () => void
    const activeDone = new Promise<void>((resolve) => {
      resolveActiveDone = resolve
    })
    const end = (emitEnd: boolean): void => {
      if (ended) {
        return
      }
      ended = true
      screencast?.session.stop()
      if (emitEnd && screencast) {
        options.emit({ type: 'end', subscriptionId: screencast.subscriptionId })
      }
    }
    const cancel = (emitEnd = false): void => {
      if (!screencast) {
        cancelledBeforeStart = true
        return
      }
      end(emitEnd)
    }
    const abortScreencast = (): void => cancel()
    const sendBinaryAfterReady = (bytes: Uint8Array<ArrayBufferLike>): boolean | void => {
      if (!readyEmitted) {
        return false
      }
      return options.sendBinary?.(bytes)
    }

    // Why: rotation can happen before ready, so replacements are connection-scoped immediately.
    this.activeByConnection.set(connectionKey, { cancel, done: activeDone, connectionKey })
    options.signal?.addEventListener('abort', abortScreencast, { once: true })
    try {
      screencast = await this.deps.getCommands().browserScreencast(params, {
        sendBinary: sendBinaryAfterReady,
        emit: options.emit,
        pairedDeviceId: options.pairedDeviceId
      })
      if (cancelledBeforeStart || options.signal?.aborted) {
        end(false)
        await screencast.session.done
        return
      }
      activeBrowserPageId = screencast.ready.browserPageId
      activePageStream = { cancel, done: activeDone, connectionKey, drivesAsMobile }
      const pageStreams =
        this.activeByPage.get(activeBrowserPageId) ?? new Set<BrowserScreencastSubscriber>()
      pageStreams.add(activePageStream)
      this.activeByPage.set(activeBrowserPageId, pageStreams)
      this.publishRemoteViewers(activeBrowserPageId)
      if (drivesAsMobile) {
        this.deps.setDriver(activeBrowserPageId, { kind: 'mobile', clientId: connectionKey })
      }
      this.deps.registerSubscriptionCleanup(
        screencast.subscriptionId,
        () => end(true),
        options.connectionId
      )
      registeredSubscriptionId = screencast.subscriptionId
      options.emit(screencast.ready)
      readyEmitted = true
      screencast.flushPendingFrame()
      await screencast.session.done
      end(true)
      this.deps.cleanupSubscription(screencast.subscriptionId)
    } finally {
      options.signal?.removeEventListener('abort', abortScreencast)
      if (!ended) {
        end(false)
      }
      if (registeredSubscriptionId) {
        this.deps.cleanupSubscription(registeredSubscriptionId)
      }
      const active = this.activeByConnection.get(connectionKey)
      if (active?.done === activeDone) {
        this.activeByConnection.delete(connectionKey)
      }
      if (activeBrowserPageId) {
        const pageStreams = this.activeByPage.get(activeBrowserPageId)
        if (activePageStream && pageStreams) {
          pageStreams.delete(activePageStream)
          if (pageStreams.size === 0) {
            this.activeByPage.delete(activeBrowserPageId)
          }
        }
        this.publishRemoteViewers(activeBrowserPageId)
        const driver = this.deps.getDriver(activeBrowserPageId)
        if (driver.kind === 'mobile' && driver.clientId === connectionKey) {
          this.deps.setDriver(
            activeBrowserPageId,
            resolveBrowserDriverAfterMobileRelease(pageStreams ?? [])
          )
        }
      }
      resolveActiveDone()
    }
  }
}
