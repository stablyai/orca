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
  writeKeybindingOverride
} from './keybinding-file'

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
  legacyTabSwitchDefaults?: boolean
  legacySearchDefaults?: boolean
  /** Gated actions ship unbound, so unbinding their overrides is enough to stop dispatch. */
  getUnavailableActionIds?: () => readonly KeybindingActionId[]
}

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private readonly defaultOverrides: KeybindingOverrides
  private readonly getUnavailableActionIds: KeybindingServiceOptions['getUnavailableActionIds']
  private fallbackOverrides: KeybindingOverrides = {}
  private snapshot: KeybindingFileSnapshot | null = null

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    this.getUnavailableActionIds = options.getUnavailableActionIds
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
    this.snapshot = readKeybindingFile(
      this.configPath,
      this.platform,
      this.defaultOverrides,
      this.fallbackOverrides
    )
    return this.snapshot
  }

  /** Dispatch view: unavailable actions are unbound; the snapshot keeps them for Settings. */
  getOverrides(): KeybindingOverrides {
    const overrides = this.getSnapshot().overrides
    const masked = (this.getUnavailableActionIds?.() ?? []).filter(
      (actionId) => (overrides[actionId]?.length ?? 0) > 0
    )
    if (masked.length === 0) {
      return overrides
    }
    const dispatchable = { ...overrides }
    for (const actionId of masked) {
      dispatchable[actionId] = []
    }
    return dispatchable
  }

  ensureFile(): KeybindingFileSnapshot {
    ensureKeybindingFile(this.configPath)
    return this.reload()
  }

  setActionBindings(
    actionId: KeybindingActionId,
    bindings: string[] | null
  ): KeybindingFileSnapshot {
    this.snapshot = writeKeybindingOverride(
      this.configPath,
      this.platform,
      actionId,
      bindings,
      this.defaultOverrides,
      this.fallbackOverrides
    )
    this.fallbackOverrides = {}
    return this.snapshot
  }
}
