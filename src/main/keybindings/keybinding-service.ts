import {
  LEGACY_TAB_SWITCH_BINDINGS,
  type KeybindingActionId,
  type KeybindingFileSnapshot,
  type KeybindingOverrides
} from '../../shared/keybindings'
import {
  ensureKeybindingFile,
  getUserKeybindingsPath,
  migrateLegacyKeybindings,
  readKeybindingFile,
  replaceKeybindingOverrides,
  seedLegacyTabSwitchBindings,
  validateKeybindingOverrides,
  writeKeybindingOverride
} from './keybinding-file'

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
  /** Cohort seed for the tab-switch convention swap. `isPending` is true only
   *  for pre-existing installs on the first launch after the swap; `markSeeded`
   *  freezes the one-shot so it never runs again. */
  legacyTabSwitchSeed?: {
    isPending: () => boolean
    markSeeded: () => void
  }
}

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private snapshot: KeybindingFileSnapshot | null = null
  private readonly changeListeners = new Set<(snapshot: KeybindingFileSnapshot) => void>()

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    // Why: older builds persisted custom shortcuts inside global settings.
    // Once a keybindings file exists, it is the sole source of truth.
    migrateLegacyKeybindings(this.configPath, this.platform, options.getLegacyOverrides?.())
    // Why: pre-existing installs keep the old tab-switch chords. Only mark the
    // one-shot done on success so a transient IO failure retries next launch
    // instead of silently dropping the pin.
    if (options.legacyTabSwitchSeed?.isPending()) {
      try {
        // Why: the seed already read the file to build its snapshot — prime the
        // lazy cache with it instead of re-reading on the first getSnapshot().
        this.snapshot = seedLegacyTabSwitchBindings(
          this.configPath,
          this.platform,
          LEGACY_TAB_SWITCH_BINDINGS
        ).snapshot
        options.legacyTabSwitchSeed.markSeeded()
      } catch (error) {
        console.error('Failed to seed legacy tab-switch keybindings:', error)
      }
    }
  }

  getPath(): string {
    return this.configPath
  }

  getSnapshot(): KeybindingFileSnapshot {
    if (!this.snapshot) {
      this.snapshot = readKeybindingFile(this.configPath, this.platform)
    }
    return this.snapshot
  }

  reload(): KeybindingFileSnapshot {
    this.snapshot = readKeybindingFile(this.configPath, this.platform)
    this.notifyChanged()
    return this.snapshot
  }

  getOverrides(): KeybindingOverrides {
    return this.getSnapshot().overrides
  }

  ensureFile(): KeybindingFileSnapshot {
    ensureKeybindingFile(this.configPath)
    return this.reload()
  }

  validateOverrides(overrides: KeybindingOverrides): KeybindingOverrides {
    return validateKeybindingOverrides(this.platform, overrides)
  }

  onChanged(listener: (snapshot: KeybindingFileSnapshot) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  replaceOverrides(overrides: KeybindingOverrides): KeybindingFileSnapshot {
    this.snapshot = replaceKeybindingOverrides(this.configPath, this.platform, overrides)
    this.notifyChanged()
    return this.snapshot
  }

  setActionBindings(
    actionId: KeybindingActionId,
    bindings: string[] | null
  ): KeybindingFileSnapshot {
    this.snapshot = writeKeybindingOverride(this.configPath, this.platform, actionId, bindings)
    this.notifyChanged()
    return this.snapshot
  }

  private notifyChanged(): void {
    if (!this.snapshot) {
      return
    }
    for (const listener of this.changeListeners) {
      try {
        listener(this.snapshot)
      } catch (error) {
        // Persistence has already succeeded; one observer must not block the others.
        console.error('Keybinding change listener failed:', error)
      }
    }
  }
}
