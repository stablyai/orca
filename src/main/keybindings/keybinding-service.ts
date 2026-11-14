import {
  getLegacySearchBindings,
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
  writeKeybindingOverride
} from './keybinding-file'

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
  legacyTabSwitchDefaults?: boolean
  legacySearchDefaults?: boolean
}

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private readonly defaultOverrides: KeybindingOverrides
  private fallbackOverrides: KeybindingOverrides = {}
  private snapshot: KeybindingFileSnapshot | null = null
  private readonly changeListeners = new Set<() => void>()

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    this.defaultOverrides = {
      ...(options.legacyTabSwitchDefaults ? LEGACY_TAB_SWITCH_BINDINGS : {}),
      ...(options.legacySearchDefaults ? getLegacySearchBindings(this.platform) : {})
    }
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
    return this.setSnapshot(
      readKeybindingFile(
        this.configPath,
        this.platform,
        this.defaultOverrides,
        this.fallbackOverrides
      )
    )
  }

  /** Called after every reload or write; returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private setSnapshot(snapshot: KeybindingFileSnapshot): KeybindingFileSnapshot {
    this.snapshot = snapshot
    for (const listener of this.changeListeners) {
      listener()
    }
    return snapshot
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
    const snapshot = writeKeybindingOverride(
      this.configPath,
      this.platform,
      actionId,
      bindings,
      this.defaultOverrides,
      this.fallbackOverrides
    )
    this.fallbackOverrides = {}
    return this.setSnapshot(snapshot)
  }
}
