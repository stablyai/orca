import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineMethod, defineStreamingMethod } from '../core'

export const MOBILE_WEB_WORKSPACE_STREAM_METHODS = [
  defineStreamingMethod({
    name: 'mobileWeb.workspace.subscribe',
    params: null,
    handler: async (_params, context, emit) => {
      if (context.signal?.aborted) {
        return
      }
      const subscriptionId = randomUUID()
      const key = `mobileWeb.workspace:${context.connectionId ?? 'local'}:${subscriptionId}`
      await new Promise<void>((resolve) => {
        let closed = false
        const unsubscribe = context.runtime.onClientEvent(
          (event) => {
            if (!closed && (event.type === 'reposChanged' || event.type === 'worktreesChanged')) {
              emit({ type: event.type })
            }
          },
          { consumesTerminalSideEffects: false }
        )
        const cleanup = () => context.runtime.cleanupSubscription(key)
        context.runtime.registerSubscriptionCleanup(
          key,
          () => {
            if (closed) {
              return
            }
            closed = true
            context.signal?.removeEventListener('abort', cleanup)
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          context.connectionId
        )
        context.signal?.addEventListener('abort', cleanup, { once: true })
        emit({ type: 'ready', subscriptionId })
      })
    }
  }),
  defineMethod({
    name: 'mobileWeb.workspace.unsubscribe',
    params: z.object({ subscriptionId: z.string().uuid() }),
    handler: (params, context) => {
      context.runtime.cleanupSubscription(
        `mobileWeb.workspace:${context.connectionId ?? 'local'}:${params.subscriptionId}`
      )
      return { unsubscribed: true }
    }
  })
]
