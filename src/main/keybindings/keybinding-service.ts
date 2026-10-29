import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides
} from '../../shared/keybindings'
import { prepareKeybindingsThroughFilesystemHost } from '../filesystem-host/filesystem-host-read-client'
import { getUserKeybindingsPath, readKeybindingFile } from './keybinding-file'

export type KeybindingServiceOptions = {
  homePath: string
  platform?: NodeJS.Platform
  getLegacyOverrides?: () => KeybindingOverrides | undefined
  legacyTabSwitchSeed?: { isPending: () => boolean; markSeeded: () => void }
}

export class KeybindingService {
  private readonly configPath: string
  private readonly platform: NodeJS.Platform
  private snapshot: KeybindingFileSnapshot
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: KeybindingServiceOptions) {
    this.configPath = getUserKeybindingsPath(options.homePath)
    this.platform = options.platform ?? process.platform
    this.snapshot = readKeybindingFile(this.configPath, this.platform, null)
  }
  getPath(): string {
    return this.configPath
  }
  getSnapshot(): KeybindingFileSnapshot {
    return this.snapshot
  }
  getOverrides(): KeybindingOverrides {
    return this.snapshot.overrides
  }
  reload(): Promise<KeybindingFileSnapshot> {
    return this.prepare()
  }
  ensureFile(): Promise<KeybindingFileSnapshot> {
    return this.prepare({ ensure: true })
  }
  setActionBindings(
    actionId: KeybindingActionId,
    bindings: string[] | null
  ): Promise<KeybindingFileSnapshot> {
    return this.prepare({ mutation: { actionId, bindings } })
  }
  private prepare(change?: {
    ensure?: boolean
    mutation?: { actionId: string; bindings: string[] | null }
  }): Promise<KeybindingFileSnapshot> {
    const job = this.pending
      .catch(() => {})
      .then(async () => {
        const seed = this.options.legacyTabSwitchSeed?.isPending() ?? false
        const prepared = await prepareKeybindingsThroughFilesystemHost(
          this.configPath,
          this.platform,
          this.options.getLegacyOverrides?.(),
          seed,
          change
        )
        this.snapshot = readKeybindingFile(this.configPath, this.platform, prepared.contents)
        if (prepared.seedCompleted) {
          this.options.legacyTabSwitchSeed?.markSeeded()
        }
        return this.snapshot
      })
    this.pending = job
    return job
  }
}
