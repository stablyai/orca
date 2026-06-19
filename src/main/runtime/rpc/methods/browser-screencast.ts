import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { Screencast } from './browser-schemas'

const ScreencastUnsubscribe = z.object({
  subscriptionId: z.string().min(1, 'Missing required --subscription-id')
})

export const BROWSER_SCREENCAST_METHODS: RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'browser.screencast',
    params: Screencast,
    handler: async (params, { runtime, connectionId, sendBinary, signal }, emit) =>
      runtime.browserScreencast(params, { connectionId, sendBinary, signal, emit })
  }),
  defineMethod({
    name: 'browser.screencast.unsubscribe',
    params: ScreencastUnsubscribe,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
