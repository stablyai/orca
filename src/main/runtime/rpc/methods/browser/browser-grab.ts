import { defineMethod, defineStreamingMethod } from '../../core'
import { BrowserTarget } from '../../../../../shared/rpc-contract/rpc-param-primitives'
import {
  GrabAwait,
  GrabCaptureSelection,
  GrabSetMode,
  GrabViewportBridge
} from '../../../../../shared/rpc-contract/browser/browser-grab-params'

/** Element selection for viewers of a streamed page; see BROWSER_GRAB_RUNTIME_CAPABILITY. */
export const BROWSER_GRAB_METHODS = [
  defineMethod({
    name: 'browser.grab.setMode',
    permission: 'workspace',
    share: 'not-shared',
    params: GrabSetMode,
    handler: async (params, { runtime }) => runtime.browserGrabSetMode(params)
  }),
  defineMethod({
    name: 'browser.grab.await',
    permission: 'workspace',
    share: 'not-shared',
    params: GrabAwait,
    handler: async (params, { runtime, signal }) => runtime.browserGrabAwait(params, signal)
  }),
  defineMethod({
    name: 'browser.grab.cancel',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserGrabCancel(params)
  }),
  defineMethod({
    name: 'browser.grab.captureSelection',
    permission: 'workspace',
    share: 'not-shared',
    params: GrabCaptureSelection,
    handler: async (params, { runtime }) => runtime.browserGrabCaptureSelection(params)
  }),
  defineMethod({
    name: 'browser.grab.extractHover',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserGrabExtractHover(params)
  }),
  defineMethod({
    name: 'browser.grab.viewportBridge',
    permission: 'workspace',
    share: 'not-shared',
    params: GrabViewportBridge,
    handler: async (params, { runtime }) => runtime.browserGrabViewportBridge(params)
  }),
  defineStreamingMethod({
    name: 'browser.grab.watch',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserTarget,
    handler: async (params, { runtime, signal }, emit) =>
      runtime.browserGrabWatch(params, emit, signal)
  })
]
