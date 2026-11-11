import { defineMethod } from '../../core'
import {
  ExtensionList,
  ExtensionReload
} from '../../../../../shared/rpc-contract/browser-extension-params'
import { getRuntimeBrowserExtensions } from '../../../browser/installation/runtime-browser-commands-factory'

export const BROWSER_EXTENSION_METHODS = [
  defineMethod({
    name: 'browser.extensionList',
    permission: 'workspace',
    params: ExtensionList,
    handler: async (params) => getRuntimeBrowserExtensions().list(params)
  }),
  defineMethod({
    name: 'browser.extensionReload',
    permission: 'workspace',
    params: ExtensionReload,
    handler: async (params) => getRuntimeBrowserExtensions().reload(params)
  })
]
