import { defineMethod } from '../../core'
import {
  PageMenuImage,
  PageMenuWord,
  ReadImage
} from '../../../../../shared/rpc-contract/browser/browser-core-params'

// What a streamed page's right-click menu does on the host; hosts answering `contextMenus: 1` have these.
export const BROWSER_PAGE_MENU_METHODS = [
  defineMethod({
    name: 'browser.replaceMisspelling',
    permission: 'workspace',
    share: 'not-shared',
    params: PageMenuWord,
    handler: async (params, { runtime }) => runtime.browserReplaceMisspelling(params)
  }),
  defineMethod({
    name: 'browser.addWordToDictionary',
    permission: 'workspace',
    share: 'not-shared',
    params: PageMenuWord,
    handler: async (params, { runtime }) => runtime.browserAddWordToDictionary(params)
  }),
  defineMethod({
    name: 'browser.saveImage',
    permission: 'workspace',
    share: 'not-shared',
    params: PageMenuImage,
    handler: async (params, { runtime }) => runtime.browserSaveImage(params)
  }),
  defineMethod({
    name: 'browser.readImage',
    permission: 'workspace',
    share: 'not-shared',
    params: ReadImage,
    handler: async (params, { runtime }) => runtime.browserReadImage(params)
  })
]
