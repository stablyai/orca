import { OPENCODE_CONFIG_DIR_ENV_KEYS } from './legacy-shared-config-dir'
import { sweepOrphanedOpenCodeDirs, type OpenCodeDirGcResult } from './overlay-dir-gc'

type ReadLivePtyIds = () => Promise<readonly string[] | null>

export class OpenCodeDirGcLifecycle {
  private readonly references = new Set<string>()
  private scheduled = false

  constructor(
    private readonly getRoot: () => string,
    private readonly pluginFileName: string
  ) {}

  reference(directory: string): void {
    this.references.add(directory)
  }

  schedule(readLivePtyIds: ReadLivePtyIds, delayMs = 3 * 60_000): void {
    if (this.scheduled) {
      return
    }
    this.scheduled = true
    const timer = setTimeout(() => {
      void this.run(readLivePtyIds).catch((error) => {
        console.warn('[OpenCode] Overlay cleanup skipped:', error)
      })
    }, delayMs)
    timer.unref()
  }

  async run(readLivePtyIds: ReadLivePtyIds): Promise<OpenCodeDirGcResult> {
    for (const key of OPENCODE_CONFIG_DIR_ENV_KEYS) {
      const value = process.env[key]
      if (value) {
        this.references.add(value)
      }
    }
    return sweepOrphanedOpenCodeDirs({
      overlayRoot: this.getRoot(),
      pluginFileName: this.pluginFileName,
      referencedConfigDirs: this.references,
      readLivePtyIds
    })
  }
}
