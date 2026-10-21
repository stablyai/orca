/** Shares the host build identity so activation verifies the shipped entry bytes. */
import { join } from 'node:path'
import { hashOrcadLauncher } from '../../shared/orcad-build-identity'
import { ORCAD_LAUNCHER_FILENAME } from '../../shared/orcad-artifacts'

export function computeLocalOrcadBuildHash(localOrcadDir: string): string {
  return hashOrcadLauncher(join(localOrcadDir, ORCAD_LAUNCHER_FILENAME))
}
