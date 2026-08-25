import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { Screencast } from './browser-schemas'
import { BrowserError } from '../../../browser/browser-error'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../../../shared/runtime-types'
import { runtimeBrowserCommandsFactoryIsAvailable } from '../../runtime-browser-commands-factory'

const ScreencastUnsubscribe = z.object({
  subscriptionId: z.string().min(1, 'Missing required --subscription-id')
})

export const BROWSER_SCREENCAST_METHODS: RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'browser.screencast',
    params: Screencast,
    handler: async (
      params,
      { runtime, connectionId, pairedDeviceId, clientKind, sendBinary, signal },
      emit
    ) =>
      runtime.browserScreencast(params, {
        connectionId,
        pairedDeviceId,
        // Why: the pairing scope is what tells a phone driver apart from a desktop/web viewer of the same stream.
        clientKind,
        sendBinary,
        signal,
        emit
      })
  }),
  defineMethod({
    name: 'browser.screencast.unsubscribe',
    params: ScreencastUnsubscribe,
    handler: async (params, { runtime }) => {
      if (!runtimeBrowserCommandsFactoryIsAvailable()) {
        throw new BrowserError(
          BROWSER_UNAVAILABLE_ERROR_CODE,
          'Browser automation is unavailable on this host.'
        )
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
