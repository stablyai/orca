import { defineMethod, defineStreamingMethod } from '../../core'
import { BrowserError } from '../../../../browser/browser-error'

import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { runtimeBrowserCommandsFactoryIsAvailable } from '../../../browser/installation/runtime-browser-commands-factory'
import {
  FileChooserAnswer,
  PagePromptAnswer,
  Screencast,
  ScreencastAck,
  ScreencastReclaimForDesktop,
  ScreencastUnsubscribe
} from '../../../../../shared/rpc-contract/browser/browser-screencast-params'
import { acknowledgeBrowserScreencastFrame } from '../../../browser/screencast/browser-screencast-frame-credit'
import { respondToStreamedBrowserPagePrompt } from '../../../../browser/guest-lifecycle/prompts/browser-page-prompts'
import { answerBrowserFileChooser } from '../../../../browser/guest-lifecycle/prompts/browser-file-chooser-viewers'
import { ownerOnly } from '../bots-caller-gates'

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
    name: 'browser.pagePromptAnswer',
    permission: 'workspace',
    params: PagePromptAnswer,
    // Like an ack, the answer names what it answers; only a device streaming the asking page is heard.
    handler: async (params, { pairedDeviceId }) => ({
      result: await respondToStreamedBrowserPagePrompt(pairedDeviceId, params)
    })
  }),
  defineMethod({
    name: 'browser.fileChooserAnswer',
    permission: 'workspace',
    params: FileChooserAnswer,
    // Only the device the picker was handed to is heard.
    handler: async (params, { pairedDeviceId }) => ({
      result: await answerBrowserFileChooser(pairedDeviceId, params)
    })
  }),
  defineMethod({
    name: 'browser.screencast.reclaimForDesktop',
    permission: 'workspace',
    params: ScreencastReclaimForDesktop,
    // A desktop viewer's Take back, as on the host's own window; ends the phone's streams of the page.
    handler: async (params, context) => {
      ownerOnly(context, 'Only a person at a desktop can take a page back from the phone.')
      const { runtime } = context
      // Only pages a phone holds; a page it already left needs nothing.
      for (const [browserPageId, driver] of runtime.getAllBrowserDrivers()) {
        if (driver.kind === 'mobile' && (params.all || browserPageId === params.browserPageId)) {
          runtime.reclaimBrowserForDesktop(browserPageId)
        }
      }
      return { reclaimed: true }
    }
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
