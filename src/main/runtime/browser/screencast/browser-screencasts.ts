import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { BrowserError } from '../../../browser/browser-error'
import { randomUUID } from 'node:crypto'
import { startBrowserScreencast } from '../../../browser/cdp/screencast/browser-screencast-stream'
import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
import { rendererPublicationThrottle } from '../../../window/visibility/renderer-publication-throttle'
import { mintBrowserScreencastSubscriptionId } from './browser-screencast-subscription-id'
import {
  cancelScreencastSubscriberFrameRetry,
  deliverScreencastSubscriberFrame,
  flushCreditedScreencastFrame
} from './browser-screencast-subscriber-frame-delivery'
import {
  createBrowserScreencastFrameCredit,
  registerBrowserScreencastFrameCredit
} from './browser-screencast-frame-credit'
import {
  INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY,
  screencastSubscriberIsGhost
} from './browser-screencast-ghost-subscriber-eviction'
import type { BrowserScreencastSession } from '../../../browser/cdp/screencast/browser-screencast-stream-types'
import type { RpcBinarySender } from '../../rpc/transports/rpc-binary-sender'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from '../commands/browser-command-targets'
import type { RuntimeBrowserTabCatalog } from '../tabs/browser-tab-catalog'
import {
  applySharedScreencastFrameBudget,
  normalizeScreencastViewport,
  normalizeScreencastFrameBudget,
  hasScreencastViewportSize
} from './browser-screencast-budget'
import type {
  BrowserScreencastParams,
  BrowserScreencastStartResult,
  ActiveBrowserScreencastSubscriber,
  ActiveBrowserScreencastPage
} from './browser-screencast-contracts'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import { watchGuestPointer } from '../../../browser/guest-lifecycle/input/browser-guest-pointer-watch'
import { askScreencastViewerPagePrompts } from './browser-screencast-page-prompts'

export class RuntimeBrowserScreencasts {
  private readonly activeScreencastsByPageId = new Map<string, ActiveBrowserScreencastPage>()

  constructor(
    private readonly host: Pick<RuntimeBrowserCommandHost, 'getAvailableAuthoritativeWindowId'>,
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'resolveBrowserCommandTarget' | 'resolveBrowserPageWebContents'
    >,
    private readonly catalog: Pick<
      RuntimeBrowserTabCatalog,
      'resolveClientHostedBrowserPage' | 'describeBrowserTab'
    >
  ) {}

  async browserScreencast(
    params: BrowserScreencastParams,
    stream: {
      sendBinary: RpcBinarySender
      emit?: (event: BrowserScreencastResult) => void
      pairedDeviceId?: string
    }
  ): Promise<BrowserScreencastStartResult> {
    if (await this.catalog.resolveClientHostedBrowserPage(params)) {
      throw new BrowserError(
        'browser_error',
        'Client-hosted browser pages do not support server screencast.'
      )
    }
    const target = await this.targets.resolveBrowserCommandTarget(params, {
      waitForFirstLoad: false
    })
    const { browserPageId, webContents: guest } = this.targets.resolveBrowserPageWebContents(
      target.worktreeId,
      target.browserPageId
    )
    const subscriptionId = mintBrowserScreencastSubscriptionId(browserPageId, randomUUID())
    const viewport = normalizeScreencastViewport(params)
    const budget = normalizeScreencastFrameBudget(params)
    let resolveSubscriberDone!: () => void
    const subscriberDone = new Promise<void>((resolve) => {
      resolveSubscriberDone = resolve
    })
    let createdPageStream = false
    let active = this.activeScreencastsByPageId.get(browserPageId)
    while (active?.stopping) {
      await active.session?.done
      active = this.activeScreencastsByPageId.get(browserPageId)
    }
    if (!active) {
      createdPageStream = true
      const subscribers = new Map<string, ActiveBrowserScreencastSubscriber>()
      const pointerWatch = watchGuestPointer(guest, (pointer) => {
        for (const subscriber of subscribers.values()) {
          if (subscriber.pointerEvents) {
            subscriber.emit?.({ type: 'pointer', ...pointer })
          }
        }
      })
      const pendingRecord: Omit<ActiveBrowserScreencastPage, 'started'> = {
        format: params.format,
        session: null,
        stopping: false,
        subscribers,
        viewportOwnerSubscriptionId: null,
        appliedBudget: budget,
        pointer: pointerWatch.current
      }
      // Hidden host compositors stop producing guest frames when throttled.
      const windowId = this.host.getAvailableAuthoritativeWindowId()
      const releaseThrottle =
        windowId !== null
          ? (getRuntimeDesktopSurface().holdRendererPublication?.(windowId) ?? (() => {}))
          : () => {}
      // Active-tab covers hide the guest widget independently of the host.
      const releaseGuestThrottle = rendererPublicationThrottle.acquire(guest)
      const started = startBrowserScreencast(guest, {
        format: params.format,
        ...budget,
        ...viewport,
        holdPaint: () => browserManager.holdPaintForCapture(guest.id),
        onFrame: (bytes) => {
          const ghosts: string[] = []
          for (const [subscriptionId, subscriber] of pendingRecord.subscribers) {
            deliverScreencastSubscriberFrame(subscriber, bytes)
            if (screencastSubscriberIsGhost(subscriber.delivery)) {
              ghosts.push(subscriptionId)
            }
          }
          // Finish fan-out before eviction can tear down the shared session.
          for (const subscriptionId of ghosts) {
            if (pendingRecord.session) {
              this.leaveScreencastSubscriber(pendingRecord, subscriptionId, pendingRecord.session)
            }
          }
          return true
        },
        onEvent: (event) => {
          for (const subscriber of pendingRecord.subscribers.values()) {
            subscriber.emit?.(event)
          }
        },
        onError: (message) => {
          for (const subscriber of pendingRecord.subscribers.values()) {
            subscriber.emit?.({ type: 'error', message })
          }
          // Terminal errors must force newcomers onto a fresh stream.
          if (pendingRecord.session) {
            pendingRecord.stopping = true
            pendingRecord.session.stop()
          }
        }
      })
      const record: ActiveBrowserScreencastPage = Object.assign(pendingRecord, { started })
      active = record
      this.activeScreencastsByPageId.set(browserPageId, record)
      void record.started
        .then((session) => {
          record.session = session
          return session.done
        })
        .finally(() => {
          pointerWatch.stop()
          releaseGuestThrottle()
          releaseThrottle()
          if (this.activeScreencastsByPageId.get(browserPageId) === record) {
            this.activeScreencastsByPageId.delete(browserPageId)
          }
          for (const subscriber of pendingRecord.subscribers.values()) {
            cancelScreencastSubscriberFrameRetry(subscriber)
            subscriber.resolveDone()
          }
          pendingRecord.subscribers.clear()
        })
        .catch(() => {})
    }
    const subscriber: ActiveBrowserScreencastSubscriber = {
      sendBinary: stream.sendBinary,
      emit: stream.emit,
      done: subscriberDone,
      resolveDone: resolveSubscriberDone,
      viewport,
      budget,
      pendingFrame: null,
      pendingFrameRetry: null,
      pairedDeviceId: stream.pairedDeviceId,
      delivery: INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY,
      frameCredit: null,
      pointerEvents: params.pointerEvents === 1,
      releasePagePrompts: null
    }
    if (params.frameAck === 1) {
      const credit = createBrowserScreencastFrameCredit({
        onCreditAvailable: () => flushCreditedScreencastFrame(subscriber)
      })
      subscriber.frameCredit = {
        credit,
        release: registerBrowserScreencastFrameCredit(subscriptionId, stream.pairedDeviceId, credit)
      }
    }
    active.subscribers.set(subscriptionId, subscriber)
    // A sizeless viewport owner would clear emulation for every viewer.
    if (hasScreencastViewportSize(viewport)) {
      active.viewportOwnerSubscriptionId = subscriptionId
    }
    let session: BrowserScreencastSession
    try {
      session = await active.started
    } catch (error) {
      active.subscribers.delete(subscriptionId)
      cancelScreencastSubscriberFrameRetry(subscriber)
      resolveSubscriberDone()
      throw error
    }
    try {
      if (!createdPageStream) {
        if (active.viewportOwnerSubscriptionId === subscriptionId) {
          await session.updateViewport(viewport)
        }
        await applySharedScreencastFrameBudget(active, session)
      }
    } catch (error) {
      this.leaveScreencastSubscriber(active, subscriptionId, session)
      throw error
    }
    // Retire a reconnected device's old socket only after its replacement successfully joins.
    if (stream.pairedDeviceId !== undefined && active.subscribers.has(subscriptionId)) {
      for (const [candidateId, candidate] of active.subscribers) {
        if (candidateId === subscriptionId) {
          break
        }
        if (candidate.pairedDeviceId === stream.pairedDeviceId) {
          this.leaveScreencastSubscriber(active, candidateId, session)
        }
      }
    }
    return {
      subscriptionId,
      // Flush with ready instead of waiting for the retry tick.
      flushPendingFrame: () => {
        const subscriber = active.subscribers.get(subscriptionId)
        const bytes = subscriber?.pendingFrame
        if (!subscriber || !bytes) {
          return
        }
        // Replayed delivery is the first evidence that ghost eviction may use.
        deliverScreencastSubscriberFrame(subscriber, bytes)
      },
      startPagePrompts: () => {
        const subscriber = active.subscribers.get(subscriptionId)
        if (subscriber) {
          subscriber.releasePagePrompts = askScreencastViewerPagePrompts(
            guest.id,
            params.pagePrompts,
            stream
          )
        }
      },
      session: {
        done: subscriberDone,
        stop: () => this.leaveScreencastSubscriber(active, subscriptionId, session),
        updateViewport: session.updateViewport
      },
      ready: {
        type: 'ready',
        subscriptionId,
        browserPageId,
        format: active.format,
        tab: this.catalog.describeBrowserTab(browserPageId, target.worktreeId),
        ...(subscriber.frameCredit ? { frameAck: true as const } : {}),
        ...(subscriber.pointerEvents ? { pointer: active.pointer() } : {})
      }
    }
  }

  /** Ends a page's streams with `end`, not a detach error, so viewers resubscribe to its next guest. */
  async endPageStreams(browserPageId: string): Promise<void> {
    const active = this.activeScreencastsByPageId.get(browserPageId)
    const session = active ? await active.started.catch(() => null) : null
    if (!active || !session) {
      return
    }
    active.stopping = true
    session.stop()
    await session.done
  }

  private leaveScreencastSubscriber(
    active: Pick<
      ActiveBrowserScreencastPage,
      'subscribers' | 'viewportOwnerSubscriptionId' | 'stopping' | 'appliedBudget'
    >,
    subscriptionId: string,
    session: BrowserScreencastSession
  ): void {
    const subscriber = active.subscribers.get(subscriptionId)
    if (!subscriber) {
      return
    }
    active.subscribers.delete(subscriptionId)
    cancelScreencastSubscriberFrameRetry(subscriber)
    subscriber.resolveDone()
    if (active.viewportOwnerSubscriptionId === subscriptionId) {
      const fallback = Array.from(active.subscribers.entries()).findLast(([, candidate]) =>
        hasScreencastViewportSize(candidate.viewport)
      )
      active.viewportOwnerSubscriptionId = fallback?.[0] ?? null
      if (fallback) {
        void session.updateViewport(fallback[1].viewport).catch(() => {})
      }
    }
    if (active.subscribers.size === 0) {
      active.stopping = true
      session.stop()
      return
    }
    // Departed viewers must not pin the shared frame budget.
    void applySharedScreencastFrameBudget(active, session).catch(() => {})
  }
}
