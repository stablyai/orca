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
