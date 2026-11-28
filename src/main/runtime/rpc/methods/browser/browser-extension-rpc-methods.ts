import { defineMethod } from '../../core'
import {
  ExtensionList,
  ExtensionReload
} from '../../../../../shared/rpc-contract/browser/browser-extension-params'
import { getRuntimeBrowserExtensions } from '../../../browser/installation/runtime-browser-commands-factory'
import { clientHostedPagesSettingsNote } from '../../../browser/client-pages/client-hosted-pages-settings-note'

export const BROWSER_EXTENSION_METHODS = [
  defineMethod({
    name: 'browser.extensionList',
    permission: 'workspace',
    params: ExtensionList,
    handler: async (params, { runtime }) => ({
      ...(await getRuntimeBrowserExtensions().list(params)),
      ...clientHostedPagesSettingsNote(runtime, 'extensions')
    })
  }),
  defineMethod({
    name: 'browser.extensionReload',
    permission: 'workspace',
    params: ExtensionReload,
    handler: async (params, { runtime }) => ({
      ...(await getRuntimeBrowserExtensions().reload(params)),
      ...clientHostedPagesSettingsNote(runtime, 'extensions')
    })
  })
]
