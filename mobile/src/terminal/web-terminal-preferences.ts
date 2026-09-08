import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileWebTerminalTextScale } from '../../../src/shared/mobile-web/native-operation-contract'
import {
  loadTerminalAutocompleteEnabled,
  loadTerminalTextScale,
  loadTerminalLinkOpenMode
} from '../storage/preferences'
import { loadCustomKeys } from '../storage/terminal-custom-key-storage'
import { loadTerminalAccessoryLayout } from './terminal-accessory-layout'

export async function loadWebHostTerminalPreferences(client: MobileWebBridgeClient) {
  const native = await client.native.terminalPreferences()
  const [textScale, autocompleteEnabled, linkOpenMode] = await Promise.all([
    loadTerminalTextScale({ fallback: native.textScale, rejectReadFailure: true }),
    loadTerminalAutocompleteEnabled({
      fallback: native.autocompleteEnabled,
      rejectReadFailure: true
    }),
    loadTerminalLinkOpenMode(native.linkOpenMode)
  ])
  return { textScale: textScale as MobileWebTerminalTextScale, autocompleteEnabled, linkOpenMode }
}
export async function loadWebHostTerminalAccessoryPreferences(client: MobileWebBridgeClient) {
  const native = await client.native.terminalAccessoryPreferences()
  const [customKeys, layout] = await Promise.all([
    loadCustomKeys({ fallback: native.customKeys, rejectReadFailure: true }),
    loadTerminalAccessoryLayout({ fallback: native, rejectReadFailure: true })
  ])
  return {
    customKeys,
    orderedBuiltInIds: layout.orderedBuiltInIds,
    visibleBuiltInIds: layout.visibleBuiltInIds
  }
}
