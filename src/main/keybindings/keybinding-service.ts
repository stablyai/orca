import {
  getLegacySearchBindings,
  LEGACY_TAB_SWITCH_BINDINGS
} from '../../shared/keybindings/definitions'
import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides
} from '../../shared/keybindings/types'
import {
  ensureKeybindingFile,
  getUserKeybindingsPath,
  migrateLegacyKeybindings,
  readKeybindingFile,
  writeKeybindingOverride,
  type KeybindingReadOptions
} from './keybinding-file'
import { omitInactiveFloatingWorkspaceOverrides } from '../../shared/settings/floating-workspace-cohort'

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
  legacyTabSwitchDefaults?: boolean
  legacySearchDefaults?: boolean
  /** Read on every publish; absent = the floating actions stay inert. */
  getFloatingWorkspaceShortcutsActive?: () => boolean
}

// Process-wide so a replaced service can never publish a generation a renderer already passed.
let lastPublishedGeneration = 0

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private readonly defaultOverrides: KeybindingOverrides
  private fallbackOverrides: KeybindingOverrides = {}
  private snapshot: KeybindingFileSnapshot | null = null
  private readonly getFloatingWorkspaceShortcutsActive: () => boolean

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    this.getFloatingWorkspaceShortcutsActive =
      options.getFloatingWorkspaceShortcutsActive ?? (() => false)
    this.defaultOverrides = {
      ...(options.legacyTabSwitchDefaults ? LEGACY_TAB_SWITCH_BINDINGS : {}),
      ...(options.legacySearchDefaults ? getLegacySearchBindings(this.platform) : {})
    }
    const legacyOverrides = options.getLegacyOverrides?.()
    try {
      migrateLegacyKeybindings(this.configPath, this.platform, legacyOverrides, this.readOptions())
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
    return this.publish(
      readKeybindingFile(
        this.configPath,
        this.platform,
        this.defaultOverrides,
        this.fallbackOverrides,
        this.readOptions()
      )
    )
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
      this.fallbackOverrides,
      this.readOptions()
    )
    this.fallbackOverrides = {}
    return this.publish(snapshot)
  }

  /** Fail closed when a reload cannot finish: the floating actions go inert on the last good map. */
  publishInactiveFloatingWorkspaceFallback(): KeybindingFileSnapshot {
    const current = this.getSnapshot()
    return this.publish({
      ...current,
      overrides: omitInactiveFloatingWorkspaceOverrides(current.overrides, false),
      floatingWorkspaceShortcutsActive: false
    })
  }

  private readOptions(): KeybindingReadOptions {
    return { floatingWorkspaceShortcutsActive: this.getFloatingWorkspaceShortcutsActive() }
  }

  private publish(snapshot: KeybindingFileSnapshot): KeybindingFileSnapshot {
    lastPublishedGeneration += 1
    this.snapshot = { ...snapshot, generation: lastPublishedGeneration }
    return this.snapshot
  }
}
