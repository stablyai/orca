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
  writeKeybindingOverride
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

  getSnapshot(): KeybindingFileSnapshot {
    if (!this.snapshot) {
      this.snapshot = readKeybindingFile(this.configPath, this.platform)
    }
    return this.snapshot
  }

  reload(): KeybindingFileSnapshot {
    this.snapshot = readKeybindingFile(this.configPath, this.platform)
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
    return this.snapshot
  }
}
