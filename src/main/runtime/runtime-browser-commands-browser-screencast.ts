// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserClick } from './runtime-browser-commands-browser-click'
import type {
  ActiveBrowserScreencastPage,
  ActiveBrowserScreencastSubscriber,
  BrowserCommandTargetParams,
  BrowserScreencastParams,
  BrowserScreencastStartResult
} from './runtime-browser-commands-browser-command-target-params'
import {
  applySharedScreencastFrameBudget,
  hasScreencastViewportSize,
  normalizeScreencastFrameBudget,
  normalizeScreencastViewport
} from './runtime-browser-commands-browser-command-target-params'
import type { BrowserEvalResult, BrowserScreencastResult } from '../../shared/runtime-types'
import { BrowserError } from '../browser/browser-error'
import { randomUUID } from 'node:crypto'
import { startBrowserScreencast } from '../browser/browser-screencast-stream'
import { sendRemoteBrowserScreencastFrame } from './remote-browser-screencast-frame-admission'
import {
  INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY,
  recordScreencastSubscriberSend,
  screencastSubscriberIsGhost
} from './browser-screencast-ghost-subscriber-eviction'
import type { BrowserScreencastSession } from '../browser/browser-screencast-stream-types'

export class RuntimeBrowserCommandsWithBrowserScreencast extends RuntimeBrowserCommandsWithBrowserClick {
  async browserScreencast(
    params: BrowserScreencastParams,
    stream: {
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
      emit?: (event: BrowserScreencastResult) => void
      pairedDeviceId?: string
    }
  ): Promise<BrowserScreencastStartResult> {
    if (await this.resolveClientHostedBrowserPage(params)) {
      throw new BrowserError(
        'browser_error',
        'Client-hosted browser pages do not support server screencast.'
      )
    }
    const target = await this.resolveBrowserCommandTarget(params)
    const { browserPageId, webContents: guest } = this.resolveBrowserPageWebContents(
      target.worktreeId,
      target.browserPageId
    )
    const subscriptionId = `browser-screencast:${browserPageId}:${randomUUID()}`
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
      const record = {
        format: params.format,
        session: null,
        stopping: false,
        subscribers,
        viewportOwnerSubscriptionId: null,
        appliedBudget: budget
      } as ActiveBrowserScreencastPage
      record.started = startBrowserScreencast(guest, {
        format: params.format,
        ...budget,
        ...viewport,
        onFrame: (bytes) => {
          const ghosts: string[] = []
          for (const [subscriptionId, subscriber] of record.subscribers) {
            // A slow viewer drops this frame without stalling every other viewer, but the
            // newest refusal is retained so a gate that opens later can still be filled.
            const delivered = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)
            subscriber.pendingFrame = delivered ? null : bytes
            subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, delivered)
            if (screencastSubscriberIsGhost(subscriber.delivery)) {
              ghosts.push(subscriptionId)
            }
          }
          // Evicting after the fan-out keeps a teardown that stops the session from cutting the
          // remaining viewers out of this frame.
          for (const subscriptionId of ghosts) {
            if (record.session) {
              this.leaveScreencastSubscriber(record, subscriptionId, record.session)
            }
          }
          return true
        },
        onEvent: (event) => {
          for (const subscriber of record.subscribers.values()) {
            subscriber.emit?.(event)
          }
        },
        onError: (message) => {
          for (const subscriber of record.subscribers.values()) {
            subscriber.emit?.({ type: 'error', message })
          }
        }
      })
      active = record
      this.activeScreencastsByPageId.set(browserPageId, record)
      void record.started
        .then((session) => {
          record.session = session
          return session.done
        })
        .finally(() => {
          if (this.activeScreencastsByPageId.get(browserPageId) === record) {
            this.activeScreencastsByPageId.delete(browserPageId)
          }
          for (const subscriber of record.subscribers.values()) {
            subscriber.resolveDone()
          }
          record.subscribers.clear()
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
      flushPendingFrame: () => {
        const subscriber = active.subscribers.get(subscriptionId)
        const bytes = subscriber?.pendingFrame
        if (!subscriber || !bytes) {
          return
        }
        const delivered = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)
        subscriber.pendingFrame = delivered ? null : bytes
        // The replay is this subscriber's first chance to reach its socket, so it is also where
        // an eviction-eligible delivery history starts.
        subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, delivered)
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
        tab: this.describeBrowserTab(browserPageId, target.worktreeId)
      }
    }
  }

  async browserEval(
    params: { expression: string } & BrowserCommandTargetParams
  ): Promise<BrowserEvalResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().evaluate(
      params.expression,
      target.worktreeId,
      target.browserPageId
    )
  }
}
