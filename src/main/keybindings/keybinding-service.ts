import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides
} from '../../shared/keybindings'
import {
  ensureKeybindingFile,
  getUserKeybindingsPath,
  parseKeybindingFileContents,
  writeKeybindingOverride
} from './keybinding-file'
import { prepareKeybindingsThroughFilesystemHost } from '../filesystem-host/filesystem-host-read-authority'

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

const FILESYSTEM_HOST_DIAGNOSTIC_SECTION = 'filesystem-host'

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private snapshot: KeybindingFileSnapshot
  private generation = 0
  private hydrationRetryNeeded = true
  private readonly getLegacyOverrides: KeybindingServiceOptions['getLegacyOverrides']
  private readonly legacyTabSwitchSeed: KeybindingServiceOptions['legacyTabSwitchSeed']

  constructor(options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    this.getLegacyOverrides = options.getLegacyOverrides
    this.legacyTabSwitchSeed = options.legacyTabSwitchSeed
    this.snapshot = parseKeybindingFileContents(this.configPath, null, this.platform)
  }

  getPath(): string {
    return this.configPath
  }

  getSnapshot(): KeybindingFileSnapshot {
    return this.snapshot
  }

  async hydrate(): Promise<KeybindingFileSnapshot> {
    const generation = this.generation
    let contents: string | null
    try {
      const prepared = await prepareKeybindingsThroughFilesystemHost(
        this.configPath,
        this.platform,
        this.getLegacyOverrides?.(),
        this.legacyTabSwitchSeed?.isPending() ?? false
      )
      contents = prepared.contents
      if (prepared.seedCompleted) {
        this.legacyTabSwitchSeed?.markSeeded()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        contents = null
      } else {
        if (generation === this.generation) {
          this.hydrationRetryNeeded = true
          this.snapshot = {
            ...this.snapshot,
            diagnostics: [
              ...this.snapshot.diagnostics.filter(
                (diagnostic) => diagnostic.section !== FILESYSTEM_HOST_DIAGNOSTIC_SECTION
              ),
              {
                severity: 'warning',
                section: FILESYSTEM_HOST_DIAGNOSTIC_SECTION,
                message:
                  'Keybindings could not be refreshed; Orca is using the last available shortcuts.'
              }
            ]
          }
        }
        return this.snapshot
      }
    }
    if (generation === this.generation) {
      this.snapshot = parseKeybindingFileContents(this.configPath, contents, this.platform)
      this.hydrationRetryNeeded = false
    }
    return this.snapshot
  }

  needsHydrationRetry(): boolean {
    return this.hydrationRetryNeeded
  }

  reload(): Promise<KeybindingFileSnapshot> {
    return this.hydrate()
  }

  getOverrides(): KeybindingOverrides {
    return this.getSnapshot().overrides
  }

  async ensureFile(): Promise<KeybindingFileSnapshot> {
    ensureKeybindingFile(this.configPath)
    this.generation += 1
    return await this.reload()
  }

  setActionBindings(
    actionId: KeybindingActionId,
    bindings: string[] | null
  ): KeybindingFileSnapshot {
    this.snapshot = writeKeybindingOverride(this.configPath, this.platform, actionId, bindings)
    this.generation += 1
    this.hydrationRetryNeeded = false
    return this.snapshot
  }
}
