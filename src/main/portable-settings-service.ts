import { isDeepStrictEqual } from 'node:util'
import type { Store } from './persistence'
import type { KeybindingService } from './keybindings/keybinding-service'
import {
  createPortableSettingsBundle,
  PortableSettingsApplyRequestSchema,
  remapPortableKeybindingOverrides,
  type PortableSettingsApplyRequest,
  type PortableSettingsBundle,
  type PortableSettingsCategory
} from '../shared/portable-settings'
import {
  normalizeTerminalColorOverrides,
  normalizeTerminalCustomThemes
} from '../shared/terminal-custom-themes'
import type { KeybindingFileSnapshot, KeybindingOverrides } from '../shared/keybindings'
import type { GlobalSettings } from '../shared/types'

export type PortableSettingsRuntimeService = {
  getBundle: () => PortableSettingsBundle
  apply: (request: PortableSettingsApplyRequest) => {
    bundle: PortableSettingsBundle
    appliedCategories: PortableSettingsCategory[]
  }
}

export function createPortableSettingsRuntimeService(
  store: Pick<Store, 'getSettings' | 'updateSettings' | 'restoreSettingsSnapshot'>,
  keybindings: Pick<KeybindingService, 'getSnapshot' | 'replaceOverrides' | 'validateOverrides'>,
  options: {
    onKeybindingsChanged?: (snapshot: ReturnType<KeybindingService['getSnapshot']>) => void
    runWithoutOutboundSync?: <T>(operation: () => T) => T
  } = {}
): PortableSettingsRuntimeService {
  const getBundle = (): PortableSettingsBundle =>
    createPortableSettingsBundle(store.getSettings(), keybindings.getSnapshot())

  return {
    getBundle,
    apply: (input) => {
      const operation = () => {
        const request = PortableSettingsApplyRequestSchema.parse(input)
        const categories = Array.from(new Set(request.categories))
        const updates: Partial<GlobalSettings> = {}
        let importedOverrides: KeybindingOverrides | null = null

        if (categories.includes('appearance')) {
          const { terminalColorOverrides, terminalCustomThemes, ...appearanceSettings } =
            request.bundle.categories.appearance
          Object.assign(updates, appearanceSettings)
          updates.terminalColorOverrides = terminalColorOverrides
            ? normalizeTerminalColorOverrides(terminalColorOverrides)
            : undefined
          // Linked clients are trusted for settings intent, but theme payloads still cross an RPC boundary.
          updates.terminalCustomThemes = normalizeTerminalCustomThemes(terminalCustomThemes)
        }
        if (categories.includes('input')) {
          const { keybindings: importedKeybindings, ...inputSettings } =
            request.bundle.categories.input
          Object.assign(updates, inputSettings)
          const targetPlatform = keybindings.getSnapshot().platform
          importedOverrides = remapPortableKeybindingOverrides(
            importedKeybindings.overrides,
            importedKeybindings.sourcePlatform,
            targetPlatform
          )
        }
        if (categories.includes('workflow')) {
          Object.assign(updates, request.bundle.categories.workflow)
        }

        const validatedOverrides = importedOverrides
          ? keybindings.validateOverrides(importedOverrides)
          : null
        const previousSettings = structuredClone(store.getSettings())
        let settingsApplied = false
        let keybindingSnapshot: KeybindingFileSnapshot | null = null

        if (Object.keys(updates).length > 0) {
          try {
            store.updateSettings(updates, { notifyListeners: true })
            settingsApplied = true
          } catch (error) {
            if (!settingsContainUpdates(store.getSettings(), updates)) {
              throw error
            }
            // The store commits before notifying listeners; finish the import instead of reporting a partial failure.
            settingsApplied = true
            console.error('Failed to broadcast imported settings:', error)
          }
        }
        try {
          if (validatedOverrides) {
            keybindingSnapshot = keybindings.replaceOverrides(validatedOverrides)
          }
        } catch (error) {
          if (settingsApplied) {
            try {
              store.restoreSettingsSnapshot(previousSettings, { notifyListeners: true })
            } catch (rollbackError) {
              if (!settingsContainUpdates(store.getSettings(), previousSettings)) {
                throw new AggregateError(
                  [error, rollbackError],
                  'Could not import shortcuts or restore the previous settings.'
                )
              }
              console.error('Failed to broadcast restored settings:', rollbackError)
            }
          }
          throw error
        }

        if (keybindingSnapshot) {
          try {
            options.onKeybindingsChanged?.(keybindingSnapshot)
          } catch (error) {
            // Persistence already succeeded, so a best-effort UI refresh must not report a failed import.
            console.error('Failed to broadcast imported keybindings:', error)
          }
        }
        return { bundle: getBundle(), appliedCategories: categories }
      }
      return options.runWithoutOutboundSync
        ? options.runWithoutOutboundSync(operation)
        : operation()
    }
  }
}

function settingsContainUpdates(
  settings: GlobalSettings,
  updates: Partial<GlobalSettings>
): boolean {
  return (Object.keys(updates) as (keyof GlobalSettings)[]).every((key) =>
    isDeepStrictEqual(settings[key], updates[key])
  )
}
