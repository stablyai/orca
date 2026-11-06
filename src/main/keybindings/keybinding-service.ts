import {
  LEGACY_MAC_SEARCH_BINDINGS,
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
  seedLegacyKeybindings,
  writeKeybindingOverride
} from './keybinding-file'

type LegacyKeybindingSeed = {
  isPending: () => boolean
  markSeeded: () => void
}

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
  /** Seed once for pre-existing installs; markSeeded completes the persisted cohort. */
  legacyTabSwitchSeed?: LegacyKeybindingSeed
  searchKeybindingSeed?: LegacyKeybindingSeed
}

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private snapshot: KeybindingFileSnapshot | null = null

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    // A keybindings file supersedes shortcuts stored in legacy global settings.
    migrateLegacyKeybindings(this.configPath, this.platform, options.getLegacyOverrides?.())
    // Complete the cohort only after successful pinning so transient I/O failures retry next launch.
    for (const [seed, bindings, name] of [
      [options.legacyTabSwitchSeed, LEGACY_TAB_SWITCH_BINDINGS, 'tab-switch'],
      [
        options.searchKeybindingSeed,
        this.platform === 'darwin' ? LEGACY_MAC_SEARCH_BINDINGS : {},
        'search'
      ]
    ] as const) {
      if (!seed) {
        continue
      }
      const pending = seed.isPending()
      try {
        // Seed already read the file; reuse its snapshot for the lazy cache.
        this.snapshot = seedLegacyKeybindings(
          this.configPath,
          this.platform,
          pending ? bindings : {},
          name
        ).snapshot
        if (pending) {
          seed.markSeeded()
        }
      } catch (error) {
        console.error(`Failed to seed legacy ${name} keybindings:`, error)
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
