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
      // Hidden host compositors stop producing guest frames when throttled.
      const win = this.host.getAvailableAuthoritativeWindow()
      const releaseThrottle = win ? rendererPublicationThrottle.acquire(win.webContents) : () => {}
      // Active-tab covers hide the guest widget independently of the host.
      const releaseGuestThrottle = rendererPublicationThrottle.acquire(guest)
      const started = startBrowserScreencast(guest, {
        format: params.format,
        ...budget,
        ...viewport,
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
    // A sizeless viewport owner would clear emulation for every viewer.
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
