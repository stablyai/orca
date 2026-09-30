import { join } from 'node:path'
import { readOrcadBuildHash } from '../../shared/orcad-build-hash'

export { ORCAD_BUILD_HASH_LENGTH } from '../../shared/orcad-build-hash'

/** The activation gate compares this with the host's hash of the same installed bytes. */
export function computeLocalOrcadBuildHash(localOrcadDir: string): string {
  return readOrcadBuildHash(join(localOrcadDir, 'orcad.js'))
}
