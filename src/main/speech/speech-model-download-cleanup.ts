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

export function removeModelDownloadFiles(
  modelDir: string,
  stagingDir: string,
  legacyArchivePath: string
): void {
  removeModelDownloadStaging(stagingDir, legacyArchivePath)
  try {
    rmSync(modelDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}
