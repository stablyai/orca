import { LEGACY_TAB_SWITCH_BINDINGS } from '../../shared/keybindings/definitions'
import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides,
  SearchShortcutChoice,
  SearchShortcutChoiceResult
} from '../../shared/keybindings/types'
import {
  getLegacyProfileSearchDefaults,
  planSearchShortcutOptInForSnapshot,
  searchShortcutOptInIsEffective,
  type SearchShortcutPluginOwner
} from '../../shared/keybindings/search-shortcut-opt-in'
import {
  ensureKeybindingFile,
  getUserKeybindingsPath,
  migrateLegacyKeybindings,
  readKeybindingFile,
  writeKeybindingOverride
} from './keybinding-file'

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
  legacyTabSwitchDefaults?: boolean
  legacySearchDefaults?: boolean
  /** The profile's in-memory choice: what the next save and a restart carry, even after an indeterminate write. */
  readSearchShortcutChoice?: () => SearchShortcutChoice | null
  persistSearchShortcutChoice?: (choice: SearchShortcutChoice) => Promise<void>
  getSearchShortcutPluginOwners?: () => readonly SearchShortcutPluginOwner[]
}

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private readonly legacyTabSwitchDefaults: boolean
  private readonly legacySearchDefaults: boolean
  private readonly readSearchShortcutChoice: () => SearchShortcutChoice | null
  private readonly persistSearchShortcutChoice?: (choice: SearchShortcutChoice) => Promise<void>
  private readonly getSearchShortcutPluginOwners: () => readonly SearchShortcutPluginOwner[]
  private searchShortcutChoice: SearchShortcutChoice | null
  private searchShortcutSaveUnconfirmed = false
  private searchShortcutWrite: Promise<unknown> = Promise.resolve()
  private defaultOverrides: KeybindingOverrides
  private fallbackOverrides: KeybindingOverrides = {}
  private snapshot: KeybindingFileSnapshot | null = null

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    this.legacyTabSwitchDefaults = options.legacyTabSwitchDefaults === true
    this.legacySearchDefaults = options.legacySearchDefaults === true
    this.readSearchShortcutChoice = options.readSearchShortcutChoice ?? (() => null)
    this.persistSearchShortcutChoice = options.persistSearchShortcutChoice
    this.getSearchShortcutPluginOwners = options.getSearchShortcutPluginOwners ?? (() => [])
    this.searchShortcutChoice = this.legacySearchDefaults ? this.readSearchShortcutChoice() : null
    this.defaultOverrides = this.buildDefaultOverrides()
    const legacyOverrides = options.getLegacyOverrides?.()
    try {
      migrateLegacyKeybindings(this.configPath, this.platform, legacyOverrides)
    } catch (error) {
      this.fallbackOverrides = { ...legacyOverrides }
      console.error('Failed to import legacy keybindings:', error)
    }
  }

  getPath(): string {
    return this.configPath
  }

  getSnapshot(): KeybindingFileSnapshot {
    if (!this.snapshot) {
      return this.reload()
    }
    return this.snapshot
  }

  reload(): KeybindingFileSnapshot {
    this.snapshot = this.withSearchShortcut(
      readKeybindingFile(
        this.configPath,
        this.platform,
        this.defaultOverrides,
        this.fallbackOverrides
      )
    )
    return this.snapshot
  }

  getOverrides(): KeybindingOverrides {
    return this.getSnapshot().overrides
  }

  ensureFile(): KeybindingFileSnapshot {
    ensureKeybindingFile(this.configPath)
    return this.reload()
  }

  setActionBindings(
    actionId: KeybindingActionId,
    bindings: string[] | null
  ): KeybindingFileSnapshot {
    const written = writeKeybindingOverride(
      this.configPath,
      this.platform,
      actionId,
      bindings,
      this.defaultOverrides,
      this.fallbackOverrides
    )
    // The write persisted the fallback choices, so the returned snapshot must not still flag them.
    this.fallbackOverrides = {}
    this.snapshot = this.withSearchShortcut(written)
    return this.snapshot
  }

  /** Switches this profile's Search/clear defaults; the shared keybindings file is never written. */
  setSearchShortcutChoice(choice: SearchShortcutChoice): Promise<SearchShortcutChoiceResult> {
    const write = this.searchShortcutWrite.then(() => this.applySearchShortcutChoice(choice))
    this.searchShortcutWrite = write.catch(() => undefined)
    return write
  }

  private async applySearchShortcutChoice(
    choice: SearchShortcutChoice
  ): Promise<SearchShortcutChoiceResult> {
    if (!this.legacySearchDefaults || !this.persistSearchShortcutChoice) {
      return { snapshot: this.getSnapshot(), outcome: 'refused' }
    }
    if (choice === 'accepted' && this.searchShortcutChoice !== 'accepted') {
      // Fresh read and live plugin owners: either may have claimed Mod+K since the UI rendered.
      const fresh = this.reload()
      const offer = planSearchShortcutOptInForSnapshot(fresh, this.getSearchShortcutPluginOwners())
      if (offer.kind !== 'eligible') {
        return { snapshot: fresh, outcome: 'refused' }
      }
    }
    let failed = false
    // A failed save may have left the choice only in memory, so a repeat must save again before claiming success.
    if (choice !== this.searchShortcutChoice || this.searchShortcutSaveUnconfirmed) {
      try {
        await this.persistSearchShortcutChoice(choice)
        this.searchShortcutSaveUnconfirmed = false
      } catch (error) {
        failed = true
        console.error('Failed to save Search shortcut choice:', error)
      }
    }
    // Follow the store, not the attempt: an indeterminate failure keeps the new value in memory.
    this.searchShortcutChoice = this.readSearchShortcutChoice()
    this.defaultOverrides = this.buildDefaultOverrides()
    const snapshot = this.reload()
    if (this.searchShortcutChoice !== choice) {
      return { snapshot, outcome: 'unchanged' }
    }
    if (failed) {
      // Possibly committed; the UI must not claim the shortcut works, only point to Settings.
      this.searchShortcutSaveUnconfirmed = true
      return { snapshot, outcome: 'unconfirmed' }
    }
    // Action and plugin edits aren't serialized behind the save, so judge the live result, not the preflight.
    const superseded =
      choice === 'accepted' &&
      !searchShortcutOptInIsEffective(
        planSearchShortcutOptInForSnapshot(snapshot, this.getSearchShortcutPluginOwners())
      )
    return { snapshot, outcome: superseded ? 'superseded' : 'applied' }
  }

  private buildDefaultOverrides(): KeybindingOverrides {
    return {
      ...(this.legacyTabSwitchDefaults ? LEGACY_TAB_SWITCH_BINDINGS : {}),
      ...(this.legacySearchDefaults
        ? getLegacyProfileSearchDefaults(this.platform, this.searchShortcutChoice)
        : {})
    }
  }

  private withSearchShortcut(snapshot: KeybindingFileSnapshot): KeybindingFileSnapshot {
    if (!this.legacySearchDefaults || !this.persistSearchShortcutChoice) {
      return snapshot
    }
    // Failed legacy import keeps choices in memory only, so the file isn't the whole explicit state.
    const fileError = Object.keys(this.fallbackOverrides).length > 0
    return {
      ...snapshot,
      searchShortcut: {
        choice: this.searchShortcutChoice,
        ...(fileError ? { fileError: true as const } : {})
      }
    }
  }
}
