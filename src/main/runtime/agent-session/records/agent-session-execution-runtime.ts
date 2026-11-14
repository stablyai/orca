import { basename } from 'node:path'
import { hashOrcadLauncher } from '../../../../shared/orcad-build-identity'
import {
  ORCAD_LAUNCHER_FILENAME,
  ORCAD_SERVER_ENTRY_FILENAME
} from '../../../../shared/orcad-artifacts'

export const executionBuildHash = (() => {
  try {
    const entry = process.argv[1]
    return entry && [ORCAD_LAUNCHER_FILENAME, ORCAD_SERVER_ENTRY_FILENAME].includes(basename(entry))
      ? hashOrcadLauncher(entry)
      : 'unknown'
  } catch {
    return 'unknown'
  }
})()

export function readSessionUsageBuildHash(desktopEntry?: string): string {
  if (executionBuildHash !== 'unknown') {
    return executionBuildHash
  }
  try {
    return desktopEntry && basename(desktopEntry) === 'index.js'
      ? hashOrcadLauncher(desktopEntry)
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

// Capture the executing bundle before an updater can replace its bytes on disk.
export const usageBuildHash = readSessionUsageBuildHash(
  process.versions.electron && typeof __filename === 'string' ? __filename : undefined
)
