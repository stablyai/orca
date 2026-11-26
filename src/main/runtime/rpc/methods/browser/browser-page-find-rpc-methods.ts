import { defineMethod } from '../../core'
import { BrowserTarget } from '../../../../../shared/rpc-contract/rpc-param-primitives'
import { FindInPage } from '../../../../../shared/rpc-contract/browser/browser-core-params'

// Chromium find in page; browser.find is the element locator.
export const BROWSER_PAGE_FIND_METHODS = [
  defineMethod({
    name: 'browser.findInPage',
    permission: 'workspace',
    params: FindInPage,
    handler: async (params, { runtime }) => runtime.browserFindInPage(params)
  }),
  defineMethod({
    name: 'browser.stopFindInPage',
    permission: 'workspace',
    params: BrowserTarget,
    handler: async (params, { runtime }) => runtime.browserStopFindInPage(params)
  })
]
