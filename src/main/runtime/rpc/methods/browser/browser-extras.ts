import { defineMethod } from '../../core'
import { assertRpcClipboardTextWriteWithinLimit } from '../../clipboard/rpc-clipboard-text-validation'
import {
  BrowserTarget,
  ExpectUrlBrowserTarget
} from '../../../../../shared/rpc-contract/rpc-param-primitives'
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
} from '../../../../../shared/rpc-contract/browser/browser-params'
import {
  DropFiles,
  MouseClick
} from '../../../../../shared/rpc-contract/browser/browser-extras-params'
import {
  AudioMuted,
  PageZoom,
  SiteColorScheme
} from '../../../../../shared/rpc-contract/browser/browser-core-params'

export const BROWSER_EXTRA_METHODS = [
  defineMethod({
    name: 'browser.cookie.get',
    permission: 'workspace',
    share: 'not-shared',
    params: CookieGet,
    handler: async (params, { runtime }) => runtime.browserCookieGet(params)
  }),
  defineMethod({
    name: 'browser.cookie.set',
    permission: 'workspace',
    share: 'not-shared',
    params: CookieSet,
    handler: async (params, { runtime }) => runtime.browserCookieSet(params)
  }),
  defineMethod({
    name: 'browser.cookie.delete',
    permission: 'workspace',
    share: 'not-shared',
    params: CookieDelete,
    handler: async (params, { runtime }) => runtime.browserCookieDelete(params)
  }),
  defineMethod({
    name: 'browser.viewport',
    permission: 'workspace',
    share: 'not-shared',
    params: Viewport,
    handler: async (params, { runtime }) => runtime.browserSetViewport(params)
  }),
  defineMethod({
    name: 'browser.geolocation',
    permission: 'workspace',
    share: 'not-shared',
    params: Geolocation,
    handler: async (params, { runtime }) => runtime.browserSetGeolocation(params)
  }),
  defineMethod({
    name: 'browser.intercept.enable',
    permission: 'workspace',
    share: 'not-shared',
    params: InterceptEnable,
    handler: async (params, { runtime }) => runtime.browserInterceptEnable(params)
  }),
  defineMethod({
    name: 'browser.intercept.disable',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserInterceptDisable(params)
  }),
  defineMethod({
    name: 'browser.intercept.list',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserInterceptList(params)
  }),
  defineMethod({
    name: 'browser.mouseMove',
    permission: 'workspace',
    share: 'not-shared',
    params: MouseXY,
    handler: async (params, { runtime }) => runtime.browserMouseMove(params)
  }),
  defineMethod({
    name: 'browser.mouseDown',
    permission: 'workspace',
    share: 'not-shared',
    params: MouseButton,
    handler: async (params, { runtime }) => runtime.browserMouseDown(params)
  }),
  defineMethod({
    name: 'browser.mouseClick',
    permission: 'workspace',
    share: 'not-shared',
    params: MouseClick,
    handler: async (params, { runtime }) => runtime.browserMouseClick(params)
  }),
  defineMethod({
    name: 'browser.dropFiles',
    permission: 'workspace',
    share: 'not-shared',
    params: DropFiles,
    handler: async (params, { runtime }) => runtime.browserDropFiles(params)
  }),
  defineMethod({
    name: 'browser.mouseUp',
    permission: 'workspace',
    share: 'not-shared',
    params: MouseButton,
    handler: async (params, { runtime }) => runtime.browserMouseUp(params)
  }),
  defineMethod({
    name: 'browser.zoom',
    permission: 'workspace',
    share: 'not-shared',
    params: PageZoom,
    handler: async (params, { runtime }) => runtime.browserZoom(params)
  }),
  defineMethod({
    name: 'browser.siteDisplay',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserSiteDisplay(params)
  }),
  defineMethod({
    name: 'browser.setSiteColorScheme',
    permission: 'workspace',
    share: 'not-shared',
    params: SiteColorScheme,
    handler: async (params, { runtime }) => runtime.browserSetSiteColorScheme(params)
  }),
  defineMethod({
    name: 'browser.setAudioMuted',
    permission: 'workspace',
    share: 'not-shared',
    params: AudioMuted,
    handler: async (params, { runtime }) => runtime.browserSetAudioMuted(params)
  }),
  defineMethod({
    name: 'browser.mouseWheel',
    permission: 'workspace',
    share: 'not-shared',
    params: MouseWheel,
    handler: async (params, { runtime }) => runtime.browserMouseWheel(params)
  }),
  defineMethod({
    name: 'browser.setDevice',
    permission: 'workspace',
    share: 'not-shared',
    params: SetDevice,
    handler: async (params, { runtime }) => runtime.browserSetDevice(params)
  }),
  defineMethod({
    name: 'browser.setOffline',
    permission: 'workspace',
    share: 'not-shared',
    params: SetOffline,
    handler: async (params, { runtime }) => runtime.browserSetOffline(params)
  }),
  defineMethod({
    name: 'browser.setHeaders',
    permission: 'workspace',
    share: 'not-shared',
    params: SetHeaders,
    handler: async (params, { runtime }) => runtime.browserSetHeaders(params)
  }),
  defineMethod({
    name: 'browser.setCredentials',
    permission: 'workspace',
    share: 'not-shared',
    params: SetCredentials,
    handler: async (params, { runtime }) => runtime.browserSetCredentials(params)
  }),
  defineMethod({
    name: 'browser.setMedia',
    permission: 'workspace',
    share: 'not-shared',
    params: SetMedia,
    handler: async (params, { runtime }) => runtime.browserSetMedia(params)
  }),
  defineMethod({
    name: 'browser.clipboardRead',
    permission: 'workspace',
    share: 'not-shared',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserClipboardRead(params)
  }),
  defineMethod({
    name: 'browser.clipboardWrite',
    permission: 'workspace',
    share: 'not-shared',
    params: ClipboardWrite,
    handler: async (params, { runtime }) => {
      await assertRpcClipboardTextWriteWithinLimit(params.text)
      return runtime.browserClipboardWrite(params)
    }
  }),
  defineMethod({
    name: 'browser.dialogAccept',
    permission: 'workspace',
    share: 'not-shared',
    params: DialogAccept,
    handler: async (params, { runtime }) => runtime.browserDialogAccept(params)
  }),
  defineMethod({
    name: 'browser.dialogDismiss',
    permission: 'workspace',
    share: 'not-shared',
    params: ExpectUrlBrowserTarget,
    handler: async (params, { runtime }) => runtime.browserDialogDismiss(params)
  }),
  defineMethod({
    name: 'browser.storage.local.get',
    permission: 'workspace',
    share: 'not-shared',
    params: StorageKey,
    handler: async (params, { runtime }) => runtime.browserStorageLocalGet(params)
  }),
  defineMethod({
    name: 'browser.storage.local.set',
    permission: 'workspace',
    share: 'not-shared',
    params: StorageKeyValue,
    handler: async (params, { runtime }) => runtime.browserStorageLocalSet(params)
  }),
  defineMethod({
    name: 'browser.storage.local.clear',
    permission: 'workspace',
    share: 'not-shared',
    params: ExpectUrlBrowserTarget,
    handler: async (params, { runtime }) => runtime.browserStorageLocalClear(params)
  }),
  defineMethod({
    name: 'browser.storage.session.get',
    permission: 'workspace',
    share: 'not-shared',
    params: StorageKey,
    handler: async (params, { runtime }) => runtime.browserStorageSessionGet(params)
  }),
  defineMethod({
    name: 'browser.storage.session.set',
    permission: 'workspace',
    share: 'not-shared',
    params: StorageKeyValue,
    handler: async (params, { runtime }) => runtime.browserStorageSessionSet(params)
  }),
  defineMethod({
    name: 'browser.storage.session.clear',
    permission: 'workspace',
    share: 'not-shared',
    params: ExpectUrlBrowserTarget,
    handler: async (params, { runtime }) => runtime.browserStorageSessionClear(params)
  })
]
