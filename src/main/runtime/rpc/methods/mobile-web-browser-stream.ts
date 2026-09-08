import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { decodeBrowserScreencastFrame } from '../../../../shared/browser-screencast-protocol'
import type { MobileWebBrowserEvent } from '../../../../shared/mobile-web/browser-operation-contract'
import { defineMethod, defineStreamingMethod } from '../core'
import { MobileWebBrowserTarget } from './mobile-web-browser-target'
import { mobileWebBrowserFrameChunks } from './mobile-web-browser-frame-chunks'
import { mobileWebBrowserPageEvent } from './mobile-web-browser-page-event'

function subscriptionKey(connectionId: string | undefined, subscriptionId: string): string {
  return `mobileWeb.browser:${connectionId ?? 'local'}:${subscriptionId}`
}

export const MOBILE_WEB_BROWSER_STREAM_METHODS = [
  defineStreamingMethod({
    name: 'mobileWeb.browser.subscribe',
    params: MobileWebBrowserTarget.extend({
      format: z.enum(['jpeg', 'png']),
      quality: z.number().int().min(1).max(100),
      maxWidth: z.number().int().min(1).max(2400),
      maxHeight: z.number().int().min(1).max(2160),
      viewportWidth: z.number().int().min(1).max(10_000).optional(),
      viewportHeight: z.number().int().min(1).max(10_000).optional(),
      deviceScaleFactor: z.number().finite().min(0.1).max(10).optional(),
      mobile: z.boolean().optional(),
      everyNthFrame: z.number().int().min(1).max(60),
      minFrameIntervalMs: z.number().int().min(16).max(10_000)
    }),
    handler: async (params, context, emit) => {
      const subscriptionId = randomUUID()
      const key = subscriptionKey(context.connectionId, subscriptionId)
      const inner = new AbortController()
      let closed = false
      const close = (event?: MobileWebBrowserEvent): void => {
        if (closed) {
          return
        }
        closed = true
        if (event) {
          emit(event)
        }
        inner.abort()
      }
      const end = (): void => close({ type: 'end' })
      context.runtime.registerSubscriptionCleanup(key, end, context.connectionId)
      context.signal?.addEventListener('abort', end, { once: true })
      if (context.signal?.aborted) {
        context.runtime.cleanupSubscription(key)
        context.signal.removeEventListener('abort', end)
        return
      }
      // The shell learns the cancel id from this frame, so it precedes anything the stream sends.
      emit({ type: 'ready', subscriptionId })
      const deliverFrame = (bytes: Uint8Array): boolean => {
        if (closed) {
          return true
        }
        const frame = decodeBrowserScreencastFrame(bytes)
        if (!frame) {
          return true
        }
        const chunks = mobileWebBrowserFrameChunks(frame)
        // An error retires the stream on this lane, which is the honest end for a producer whose
        // frames the page contract cannot describe at all.
        if (!chunks) {
          close({ type: 'error', message: 'Browser frame cannot be displayed safely.' })
          return true
        }
        for (const chunk of chunks) {
          emit(chunk)
        }
        return true
      }
      try {
        await context.runtime.browserScreencast(params, {
          connectionId: context.connectionId,
          pairedDeviceId: context.pairedDeviceId,
          clientKind: context.clientKind,
          signal: inner.signal,
          sendBinary: deliverFrame,
          emit: (event) => {
            if (closed) {
              return
            }
            const projected = mobileWebBrowserPageEvent(event)
            if (!projected) {
              return
            }
            if (projected.type === 'end' || projected.type === 'error') {
              close(projected)
              return
            }
            emit(projected)
          }
        })
      } catch {
        close({ type: 'error', message: 'Browser stream failed.' })
      } finally {
        context.signal?.removeEventListener('abort', end)
        context.runtime.cleanupSubscription(key)
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.browser.unsubscribe',
    params: z.object({ subscriptionId: z.string().uuid() }),
    handler: (params, context) => {
      context.runtime.cleanupSubscription(
        subscriptionKey(context.connectionId, params.subscriptionId)
      )
      return { unsubscribed: true }
    }
  })
]
