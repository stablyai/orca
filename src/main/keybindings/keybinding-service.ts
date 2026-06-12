import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides
} from '../../shared/keybindings'
import {
  ensureKeybindingFile,
  getUserKeybindingsPath,
  migrateLegacyKeybindings,
  readKeybindingFile,
  validateKeybindingPortableOverrides,
  writeKeybindingOverride,
  writeKeybindingPortableOverrides
} from './keybinding-file'

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
}

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private snapshot: KeybindingFileSnapshot | null = null
  private readonly changeListeners = new Set<() => void>()

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    // Why: older builds persisted custom shortcuts inside global settings.
    // Once a keybindings file exists, it is the sole source of truth.
    migrateLegacyKeybindings(this.configPath, this.platform, options.getLegacyOverrides?.())
  }

  getPath(): string {
    return this.configPath
  }

  /** Fires after any write or reload that may change the overrides, so
   *  renderer windows and menus can refresh their shortcut state. */
  onDidChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch (error) {
        console.warn('[keybindings] change listener failed:', error)
      }
    }
  }

  getSnapshot(): KeybindingFileSnapshot {
    if (!this.snapshot) {
      this.snapshot = readKeybindingFile(this.configPath, this.platform)
    }
    return this.snapshot
  }

  reload(): KeybindingFileSnapshot {
    this.snapshot = readKeybindingFile(this.configPath, this.platform)
    this.emitChange()
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
    this.snapshot = writeKeybindingOverride(this.configPath, this.platform, actionId, bindings)
    this.emitChange()
    return this.snapshot
  }

  replacePortableOverrides(value: unknown): KeybindingFileSnapshot {
    this.snapshot = writeKeybindingPortableOverrides(this.configPath, this.platform, value)
    this.emitChange()
    return this.snapshot
  }

  validatePortableOverrides(value: unknown): void {
    validateKeybindingPortableOverrides(value)
  }
}
