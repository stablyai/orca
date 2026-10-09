import { defineMethod } from '../core'
import { assertRpcClipboardTextWriteWithinLimit } from '../rpc-clipboard-text-validation'
import { BrowserTarget } from '../schemas'
import {
  ClipboardWrite,
  CookieDelete,
  CookieGet,
  CookieSet,
  DialogAccept,
  Geolocation,
  InterceptEnable,
  MouseButton,
  MouseWheel,
  MouseXY,
  SetCredentials,
  SetDevice,
  SetHeaders,
  SetMedia,
  SetOffline,
  StorageKey,
  StorageKeyValue,
  Viewport
} from './browser-schemas'
import { MouseClick } from '../../../../shared/rpc-contract/browser-extras-params'

export const BROWSER_EXTRA_METHODS = [
  defineMethod({
    name: 'browser.cookie.get',
    permission: 'workspace',
    params: CookieGet,
    handler: async (params, { runtime }) => runtime.browserCookieGet(params)
  }),
  defineMethod({
    name: 'browser.cookie.set',
    permission: 'workspace',
    params: CookieSet,
    handler: async (params, { runtime }) => runtime.browserCookieSet(params)
  }),
  defineMethod({
    name: 'browser.cookie.delete',
    permission: 'workspace',
    params: CookieDelete,
    handler: async (params, { runtime }) => runtime.browserCookieDelete(params)
  }),
  defineMethod({
    name: 'browser.viewport',
    permission: 'workspace',
    params: Viewport,
    handler: async (params, { runtime }) => runtime.browserSetViewport(params)
  }),
  defineMethod({
    name: 'browser.geolocation',
    permission: 'workspace',
    params: Geolocation,
    handler: async (params, { runtime }) => runtime.browserSetGeolocation(params)
  }),
  defineMethod({
    name: 'browser.intercept.enable',
    permission: 'workspace',
    params: InterceptEnable,
    handler: async (params, { runtime }) => runtime.browserInterceptEnable(params)
  }),
  defineMethod({
    name: 'browser.intercept.disable',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserInterceptDisable(params)
  }),
  defineMethod({
    name: 'browser.intercept.list',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserInterceptList(params)
  }),
  defineMethod({
    name: 'browser.mouseMove',
    permission: 'workspace',
    params: MouseXY,
    handler: async (params, { runtime }) => runtime.browserMouseMove(params)
  }),
  defineMethod({
    name: 'browser.mouseDown',
    permission: 'workspace',
    params: MouseButton,
    handler: async (params, { runtime }) => runtime.browserMouseDown(params)
  }),
  defineMethod({
    name: 'browser.mouseClick',
    permission: 'workspace',
    params: MouseClick,
    handler: async (params, { runtime }) => runtime.browserMouseClick(params)
  }),
  defineMethod({
    name: 'browser.mouseUp',
    permission: 'workspace',
    params: MouseButton,
    handler: async (params, { runtime }) => runtime.browserMouseUp(params)
  }),
  defineMethod({
    name: 'browser.mouseWheel',
    permission: 'workspace',
    params: MouseWheel,
    handler: async (params, { runtime }) => runtime.browserMouseWheel(params)
  }),
  defineMethod({
    name: 'browser.setDevice',
    permission: 'workspace',
    params: SetDevice,
    handler: async (params, { runtime }) => runtime.browserSetDevice(params)
  }),
  defineMethod({
    name: 'browser.setOffline',
    permission: 'workspace',
    params: SetOffline,
    handler: async (params, { runtime }) => runtime.browserSetOffline(params)
  }),
  defineMethod({
    name: 'browser.setHeaders',
    permission: 'workspace',
    params: SetHeaders,
    handler: async (params, { runtime }) => runtime.browserSetHeaders(params)
  }),
  defineMethod({
    name: 'browser.setCredentials',
    permission: 'workspace',
    params: SetCredentials,
    handler: async (params, { runtime }) => runtime.browserSetCredentials(params)
  }),
  defineMethod({
    name: 'browser.setMedia',
    permission: 'workspace',
    params: SetMedia,
    handler: async (params, { runtime }) => runtime.browserSetMedia(params)
  }),
  defineMethod({
    name: 'browser.clipboardRead',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserClipboardRead(params)
  }),
  defineMethod({
    name: 'browser.clipboardWrite',
    permission: 'workspace',
    params: ClipboardWrite,
    handler: async (params, { runtime }) => {
      await assertRpcClipboardTextWriteWithinLimit(params.text)
      return runtime.browserClipboardWrite(params)
    }
  }),
  defineMethod({
    name: 'browser.dialogAccept',
    permission: 'workspace',
    params: DialogAccept,
    handler: async (params, { runtime }) => runtime.browserDialogAccept(params)
  }),
  defineMethod({
    name: 'browser.dialogDismiss',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserDialogDismiss(params)
  }),
  defineMethod({
    name: 'browser.storage.local.get',
    permission: 'workspace',
    params: StorageKey,
    handler: async (params, { runtime }) => runtime.browserStorageLocalGet(params)
  }),
  defineMethod({
    name: 'browser.storage.local.set',
    permission: 'workspace',
    params: StorageKeyValue,
    handler: async (params, { runtime }) => runtime.browserStorageLocalSet(params)
  }),
  defineMethod({
    name: 'browser.storage.local.clear',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserStorageLocalClear(params)
  }),
  defineMethod({
    name: 'browser.storage.session.get',
    permission: 'workspace',
    params: StorageKey,
    handler: async (params, { runtime }) => runtime.browserStorageSessionGet(params)
  }),
  defineMethod({
    name: 'browser.storage.session.set',
    permission: 'workspace',
    params: StorageKeyValue,
    handler: async (params, { runtime }) => runtime.browserStorageSessionSet(params)
  }),
  defineMethod({
    name: 'browser.storage.session.clear',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserStorageSessionClear(params)
  })
]
