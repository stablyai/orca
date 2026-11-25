import { rmSync } from 'node:fs'

export function removeModelDownloadStaging(stagingDir: string, legacyArchivePath: string): void {
  for (const path of [stagingDir, legacyArchivePath]) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}
