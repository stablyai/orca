import { join } from 'node:path'
import { hashOrcadLauncher } from '../../../shared/remote-runtime/orcad-distribution/orcad-build-identity'
import { ORCAD_LAUNCHER_FILENAME } from '../../../shared/remote-runtime/orcad-distribution/orcad-artifacts'

export function computeLocalOrcadBuildHash(localOrcadDir: string): string {
  return hashOrcadLauncher(join(localOrcadDir, ORCAD_LAUNCHER_FILENAME))
}
