import { defineMethod, type RpcMethod } from '../core'
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

export const BROWSER_EXTRA_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'browser.cookie.get',
    params: CookieGet,
    handler: async (params, { runtime }) => runtime.browserCookieGet(params)
  }),
  defineMethod({
    name: 'browser.cookie.set',
    params: CookieSet,
    handler: async (params, { runtime }) => runtime.browserCookieSet(params)
  }),
  defineMethod({
    name: 'browser.cookie.delete',
    params: CookieDelete,
    handler: async (params, { runtime }) => runtime.browserCookieDelete(params)
  }),
  defineMethod({
    name: 'browser.viewport',
    params: Viewport,
    handler: async (params, { runtime }) => runtime.browserSetViewport(params)
  }),
  defineMethod({
    name: 'browser.geolocation',
    params: Geolocation,
    handler: async (params, { runtime }) => runtime.browserSetGeolocation(params)
  }),
  defineMethod({
    name: 'browser.intercept.enable',
    params: InterceptEnable,
    handler: async (params, { runtime }) => runtime.browserInterceptEnable(params)
  }),
  defineMethod({
    name: 'browser.intercept.disable',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserInterceptDisable(params)
  }),
  defineMethod({
    name: 'browser.intercept.list',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserInterceptList(params)
  }),
  defineMethod({
    name: 'browser.mouseMove',
    params: MouseXY,
    handler: async (params, { runtime }) => runtime.browserMouseMove(params)
  }),
  defineMethod({
    name: 'browser.mouseDown',
    params: MouseButton,
    handler: async (params, { runtime }) => runtime.browserMouseDown(params)
  }),
  defineMethod({
    name: 'browser.mouseUp',
    params: MouseButton,
    handler: async (params, { runtime }) => runtime.browserMouseUp(params)
  }),
  defineMethod({
    name: 'browser.mouseWheel',
    params: MouseWheel,
    handler: async (params, { runtime }) => runtime.browserMouseWheel(params)
  }),
  defineMethod({
    name: 'browser.setDevice',
    params: SetDevice,
    handler: async (params, { runtime }) => runtime.browserSetDevice(params)
  }),
  defineMethod({
    name: 'browser.setOffline',
    params: SetOffline,
    handler: async (params, { runtime }) => runtime.browserSetOffline(params)
  }),
  defineMethod({
    name: 'browser.setHeaders',
    params: SetHeaders,
    handler: async (params, { runtime }) => runtime.browserSetHeaders(params)
  }),
  defineMethod({
    name: 'browser.setCredentials',
    params: SetCredentials,
    handler: async (params, { runtime }) => runtime.browserSetCredentials(params)
  }),
  defineMethod({
    name: 'browser.setMedia',
    params: SetMedia,
    handler: async (params, { runtime }) => runtime.browserSetMedia(params)
  }),
  defineMethod({
    name: 'browser.clipboardRead',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserClipboardRead(params)
  }),
  defineMethod({
    name: 'browser.clipboardWrite',
    params: ClipboardWrite,
    handler: async (params, { runtime }) => runtime.browserClipboardWrite(params)
  }),
  defineMethod({
    name: 'browser.dialogAccept',
    params: DialogAccept,
    handler: async (params, { runtime }) => runtime.browserDialogAccept(params)
  }),
  defineMethod({
    name: 'browser.dialogDismiss',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserDialogDismiss(params)
  }),
  defineMethod({
    name: 'browser.storage.local.get',
    params: StorageKey,
    handler: async (params, { runtime }) => runtime.browserStorageLocalGet(params)
  }),
  defineMethod({
    name: 'browser.storage.local.set',
    params: StorageKeyValue,
    handler: async (params, { runtime }) => runtime.browserStorageLocalSet(params)
  }),
  defineMethod({
    name: 'browser.storage.local.clear',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserStorageLocalClear(params)
  }),
  defineMethod({
    name: 'browser.storage.session.get',
    params: StorageKey,
    handler: async (params, { runtime }) => runtime.browserStorageSessionGet(params)
  }),
  defineMethod({
    name: 'browser.storage.session.set',
    params: StorageKeyValue,
    handler: async (params, { runtime }) => runtime.browserStorageSessionSet(params)
  }),
  defineMethod({
    name: 'browser.storage.session.clear',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserStorageSessionClear(params)
  })
]
