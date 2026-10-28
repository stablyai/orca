import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../../shared/terminal-custom-themes'
import type { GhosttyImportPreview, GlobalSettings } from '../../shared/global-settings-types'

export type SettingsApi = {
  get: () => Promise<GlobalSettings>
  /** Blocking IPC for startup decisions that cannot wait for hydration; call sparingly. */
  getSync: () => GlobalSettings | null
  set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
  setActiveRuntimeEnvironmentPreference: (args: {
    environmentId: string | null
  }) => Promise<GlobalSettings>
  updatePRBotAuthorOverride: (args: { author: string; isBot: boolean }) => Promise<GlobalSettings>
  listFonts: () => Promise<string[]>
  previewGhosttyImport: () => Promise<GhosttyImportPreview>
  previewWarpThemeImport: (source: WarpThemeImportSource) => Promise<WarpThemeImportPreview>
  onChanged: (callback: (updates: Partial<GlobalSettings>) => void) => () => void
}

export type KeybindingsApi = {
  get: () => Promise<KeybindingFileSnapshot>
  ensureFile: () => Promise<KeybindingFileSnapshot>
  setAction: (args: {
    actionId: KeybindingActionId
    bindings: string[] | null
  }) => Promise<KeybindingFileSnapshot>
  reload: () => Promise<KeybindingFileSnapshot>
  openFile: () => Promise<KeybindingFileSnapshot>
  revealFile: () => Promise<KeybindingFileSnapshot>
  onChanged: (callback: (snapshot: KeybindingFileSnapshot) => void) => () => void
}
