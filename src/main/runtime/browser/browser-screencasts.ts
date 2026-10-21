import { settleBrowserDialogOnLiveScreencast } from '../browser-dialog-settlement'
import type { BrowserScreencastResult } from '../../../shared/runtime-types'
import { BrowserError } from '../../browser/browser-error'
import { randomUUID } from 'node:crypto'
import { startBrowserScreencast } from '../../browser/browser-screencast-stream'
import { rendererPublicationThrottle } from '../../window/renderer-publication-throttle'
import { mintBrowserScreencastSubscriptionId } from '../browser-screencast-subscription-id'
import {
  cancelScreencastSubscriberFrameRetry,
  deliverScreencastSubscriberFrame
} from '../browser-screencast-subscriber-frame-delivery'
import {
  INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY,
  screencastSubscriberIsGhost
} from '../browser-screencast-ghost-subscriber-eviction'
import type { BrowserScreencastSession } from '../../browser/browser-screencast-stream-types'
import type { RpcBinarySender } from '../rpc/rpc-binary-sender'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
import type { RuntimeBrowserTabCatalog } from './browser-tab-catalog'
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

export class RuntimeBrowserScreencasts {
  private readonly activeScreencastsByPageId = new Map<string, ActiveBrowserScreencastPage>()

  constructor(
    private readonly host: Pick<RuntimeBrowserCommandHost, 'getAvailableAuthoritativeWindow'>,
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
    const target = await this.targets.resolveBrowserCommandTarget(params)
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
      const pendingRecord: Omit<ActiveBrowserScreencastPage, 'started'> = {
        format: params.format,
        session: null,
        stopping: false,
        subscribers,
        viewportOwnerSubscriptionId: null,
        appliedBudget: budget
      }
      // Why: guest frames come from the window's compositor, which a throttled hidden window stops.
      const win = this.host.getAvailableAuthoritativeWindow()
      const releaseThrottle = win ? rendererPublicationThrottle.acquire(win.webContents) : () => {}
      // Why: on the active tab the guest is the widget a cover hides, and its attach-time unthrottle can predate it.
      const releaseGuestThrottle = rendererPublicationThrottle.acquire(guest)
      const started = startBrowserScreencast(guest, {
        format: params.format,
        ...budget,
        ...viewport,
        onFrame: (bytes) => {
          const ghosts: string[] = []
          for (const [subscriptionId, subscriber] of pendingRecord.subscribers) {
            // A slow viewer drops this frame without stalling every other viewer.
            deliverScreencastSubscriberFrame(subscriber, bytes)
            if (screencastSubscriberIsGhost(subscriber.delivery)) {
              ghosts.push(subscriptionId)
            }
          }
          // Evicting after the fan-out keeps a teardown that stops the session from cutting the
          // remaining viewers out of this frame.
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
          // Why: every stream error is terminal; marking it stopping makes a newcomer start a fresh
          // stream instead of joining this one and waiting on frames that will never come.
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
    active.subscribers.set(subscriptionId, {
      sendBinary: stream.sendBinary,
      emit: stream.emit,
      done: subscriberDone,
      resolveDone: resolveSubscriberDone,
      viewport,
      budget,
      pendingFrame: null,
      pendingFrameRetry: null,
      pairedDeviceId: stream.pairedDeviceId,
      delivery: INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY
    })
    // Why: normalizeScreencastViewport keeps undefined dimensions, so a sizeless
    // subscriber taking ownership would clear the emulation for every viewer.
    if (hasScreencastViewportSize(viewport)) {
      active.viewportOwnerSubscriptionId = subscriptionId
    }
    let session: BrowserScreencastSession
    try {
      session = await active.started
    } catch (error) {
      active.subscribers.delete(subscriptionId)
      resolveSubscriberDone()
      throw error
    }
    // Why: a device that force-quit and reconnected arrives on a fresh socket, so the
    // connection-keyed replacement upstream cannot see its old subscription. Run this after the
    // joiner is registered — the page then never empties mid-replacement and stops the stream.
    if (stream.pairedDeviceId !== undefined) {
      // Deleting the entry being visited is well defined for a Map, and no other entry is touched.
      for (const [candidateId, candidate] of active.subscribers) {
        if (candidateId !== subscriptionId && candidate.pairedDeviceId === stream.pairedDeviceId) {
          this.leaveScreencastSubscriber(active, candidateId, session)
        }
      }
    }
    if (!createdPageStream) {
      if (active.viewportOwnerSubscriptionId === subscriptionId) {
        await session.updateViewport(viewport)
      }
      await applySharedScreencastFrameBudget(active, session)
    }
    return {
      subscriptionId,
      // Why: the frame the pre-ready gate refused goes out with ready, not a retry tick later.
      flushPendingFrame: () => {
        const subscriber = active.subscribers.get(subscriptionId)
        const bytes = subscriber?.pendingFrame
        if (!subscriber || !bytes) {
          return
        }
        // The replay is this subscriber's first chance to reach its socket, so it is also where
        // an eviction-eligible delivery history starts.
        deliverScreencastSubscriberFrame(subscriber, bytes)
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
        tab: this.catalog.describeBrowserTab(browserPageId, target.worktreeId)
      }
    }
  }

  // Explicit stops, ghost eviction and reconnect replacement must share the same teardown.
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
    // Why: a departed subscriber's caps would otherwise pin the shared stream for
    // the rest of its life, long after the client that asked for them is gone.
    void applySharedScreencastFrameBudget(active, session).catch(() => {})
  }

  settleDialog(
    browserPageId: string | undefined,
    accept: boolean,
    promptText?: string
  ): Promise<boolean> {
    return settleBrowserDialogOnLiveScreencast(
      this.activeScreencastsByPageId,
      browserPageId,
      accept,
      promptText
    )
  }
}
