import { defineMethod } from '../core'
import { assertRpcClipboardTextWriteWithinLimit } from '../rpc-clipboard-text-validation'
import { Fill, KeyboardInsert, Type } from './browser-schemas'

export const BROWSER_TEXT_METHODS = [
  defineMethod({
    name: 'browser.fill',
    permission: 'workspace',
    params: Fill,
    handler: async (params, { runtime }) => {
      await assertRpcClipboardTextWriteWithinLimit(params.value)
      return runtime.browserFill(params)
    }
  }),
  defineMethod({
    name: 'browser.type',
    permission: 'workspace',
    params: Type,
    handler: async (params, { runtime }) => {
      await assertRpcClipboardTextWriteWithinLimit(params.input)
      return runtime.browserType(params)
    }
  }),
  defineMethod({
    name: 'browser.keyboardInsertText',
    permission: 'workspace',
    params: KeyboardInsert,
    handler: async (params, { runtime }) => {
      await assertRpcClipboardTextWriteWithinLimit(params.text)
      return runtime.browserKeyboardInsertText(params)
    }
  })
]
