import { defineMethod, defineStreamingMethod } from '../../core'
import { Screencast } from '../../../../../shared/rpc-contract/browser/browser-params'
import { BrowserError } from '../../../../browser/browser-error'
import '../../../../../shared/runtime-types'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../../../../shared/runtime-session-contracts'
import { runtimeBrowserCommandsFactoryIsAvailable } from '../../../browser/installation/runtime-browser-commands-factory'
import {
  ScreencastAck,
  ScreencastUnsubscribe
} from '../../../../../shared/rpc-contract/browser/browser-screencast-params'
import { acknowledgeBrowserScreencastFrame } from '../../../browser/screencast/browser-screencast-frame-credit'

export const BROWSER_SCREENCAST_METHODS = [
  defineStreamingMethod({
    name: 'browser.screencast',
    permission: 'workspace',
    params: Screencast,
    handler: async (
      params,
      { runtime, connectionId, pairedDeviceId, clientKind, sendBinary, signal },
      emit
    ) =>
      runtime.browserScreencast(params, {
        connectionId,
        pairedDeviceId,
        // Pairing scope distinguishes phone drivers from desktop/web viewers of the same stream.
        clientKind,
        sendBinary,
        signal,
        emit
      })
  }),
  defineMethod({
    name: 'browser.screencast.unsubscribe',
    permission: 'workspace',
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
  }),
  defineMethod({
    name: 'browser.screencast.ack',
    permission: 'workspace',
    params: ScreencastAck,
    // Late acks for an ended stream are normal; report them instead of failing the request.
    handler: async (params, { pairedDeviceId }) => ({
      credited: acknowledgeBrowserScreencastFrame(params.subscriptionId, pairedDeviceId, params.seq)
    })
  })
]
