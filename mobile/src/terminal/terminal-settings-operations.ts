import {
  loadTerminalAutocompleteEnabled,
  loadTerminalTextScale,
  saveTerminalAutocompleteEnabled,
  saveTerminalTextScale
} from '../storage/preferences'
import {
  loadCustomKeys,
  saveCustomKeys,
  type CustomKey
} from '../storage/terminal-custom-key-storage'
import {
  loadTerminalAccessoryLayout,
  saveTerminalAccessoryLayout,
  type TerminalAccessoryLayout
} from './terminal-accessory-layout'

export type TerminalShortcutPreferences = {
  loadKeys: () => Promise<CustomKey[]>
  saveKeys: (keys: CustomKey[]) => Promise<void>
  loadLayout: () => Promise<TerminalAccessoryLayout>
  saveLayout: (layout: TerminalAccessoryLayout) => Promise<void>
}
export type TerminalSettingsOperations = TerminalShortcutPreferences & {
  loadPreferences: () => Promise<{ textScale: number; autocompleteEnabled: boolean }>
  saveTextScale: (scale: number) => Promise<void>
  saveAutocomplete: (enabled: boolean) => Promise<void>
}
export type TerminalSettingsHost = {
  id: string
  name: string
  loadFit: () => Promise<number | null>
  saveFit: (ms: number | null) => Promise<number | null>
}
export const nativeTerminalSettingsOperations: TerminalSettingsOperations = {
  async loadPreferences() {
    const [textScale, autocompleteEnabled] = await Promise.all([
      loadTerminalTextScale({ rejectReadFailure: true }),
      loadTerminalAutocompleteEnabled({ rejectReadFailure: true })
    ])
    return { textScale, autocompleteEnabled }
  },
  saveTextScale: saveTerminalTextScale,
  saveAutocomplete: saveTerminalAutocompleteEnabled,
  loadKeys: () => loadCustomKeys({ rejectReadFailure: true }),
  saveKeys: saveCustomKeys,
  loadLayout: () => loadTerminalAccessoryLayout({ rejectReadFailure: true }),
  saveLayout: saveTerminalAccessoryLayout
}
