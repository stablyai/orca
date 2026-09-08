import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineMethod, defineStreamingMethod, isStreamingMethod } from '../core'
import { SESSION_TAB_METHODS } from './session-tabs'
import { MobileWebSessionScope, projectMobileWebSession } from './mobile-web-session-scope'

const source = SESSION_TAB_METHODS.find((method) => method.name === 'session.tabs.subscribe')
if (!source || !isStreamingMethod(source)) {
  throw new Error('Missing session subscription')
}
const stream = source

function innerSubscriptionKey(
  event: unknown,
  connection: string,
  subscriptionId: string
): string | undefined {
  const worktree =
    typeof event === 'object' && event !== null && 'worktree' in event ? event.worktree : undefined
  return typeof worktree === 'string' && worktree.length > 0
    ? `session.tabs:${connection}:${worktree}:${subscriptionId}`
    : undefined
}

export const MOBILE_WEB_SESSION_STREAM_METHODS = [
  defineStreamingMethod({
    name: 'mobileWeb.session.subscribe',
    params: MobileWebSessionScope,
    handler: async (params, context, emit) => {
      const subscriptionId = randomUUID()
      const connection = context.connectionId ?? 'local'
      const key = `mobileWeb.session:${connection}:${subscriptionId}`
      // The inner feed keys its cleanup by the canonical worktree it resolved, never by the
      // selector the caller passed; read it off the first event instead of guessing.
      let sourceKey: string | undefined
      const cleanupSource = () => {
        if (sourceKey) {
          context.runtime.cleanupSubscription(sourceKey)
        }
      }
      let closed = false
      const cleanup = () => context.runtime.cleanupSubscription(key)
      context.runtime.registerSubscriptionCleanup(
        key,
        () => {
          if (closed) {
            return
          }
          closed = true
          context.signal?.removeEventListener('abort', cleanup)
          cleanupSource()
          emit({ type: 'end' })
        },
        context.connectionId
      )
      context.signal?.addEventListener('abort', cleanup, { once: true })
      if (context.signal?.aborted) {
        cleanup()
      }
      if (closed) {
        return
      }
      emit({ type: 'ready', subscriptionId })
      if (closed) {
        return
      }
      try {
        await stream.handler(
          stream.params!.parse({ worktree: params.worktree }),
          { ...context, requestId: subscriptionId },
          (event) => {
            // Recorded before the closed check: a feed that opened after the page unsubscribed
            // still has to be torn down, and its key only exists on its own events.
            sourceKey ??= innerSubscriptionKey(event, connection, subscriptionId)
            if (closed) {
              return
            }
            const type =
              typeof event === 'object' && event !== null && 'type' in event
                ? event.type
                : undefined
            if (type === 'end' || type === 'error') {
              if (type === 'error') {
                emit({ type: 'error', message: 'Session feed unavailable' })
              }
              cleanup()
              return
            }
            try {
              emit({ type: 'snapshot', snapshot: projectMobileWebSession(event, params, context) })
            } catch {
              emit({ type: 'error', message: 'Session snapshot unavailable' })
              cleanup()
            }
          }
        )
      } catch (error) {
        cleanup()
        throw error
      } finally {
        if (closed) {
          cleanupSource()
        }
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.session.unsubscribe',
    params: z.object({ subscriptionId: z.string().uuid() }),
    handler: (params, context) => {
      context.runtime.cleanupSubscription(
        `mobileWeb.session:${context.connectionId ?? 'local'}:${params.subscriptionId}`
      )
      return { unsubscribed: true }
    }
  })
]
