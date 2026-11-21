import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORCAD_VERSION,
  orcadArtifactFilenames
} from '../../../../src/shared/remote-runtime/orcad-distribution/orcad-artifacts.ts'
import { readOrcadMobileWebAssetFilenames } from './orcad-mobile-web-bundle.mjs'

/** The runtime enters through `.runtime-node`'s executableSha256 string, never its bytes (design D2).
 * The optional agent-browser binary stays out of this id. A desktop that ships it and one that does
 * not must not look like two Linux SSH builds of the same server (#45450). Callers may still pass
 * `agentBrowserFilename`; it no longer changes the hash. */
export function computeOrcadFullVersion(artifactDir, { target }) {
  const hash = createHash('sha256')
  for (const filename of orcadArtifactFilenames(
    target,
    readOrcadMobileWebAssetFilenames(artifactDir)
  )) {
    const artifactPath = join(artifactDir, filename)
    if (!existsSync(artifactPath)) {
      throw new Error(
        `orcad declares ${filename} in ORCAD_ARTIFACTS but never emitted it. Add the build ` +
          'step, or drop it from src/shared/remote-runtime/orcad-distribution/orcad-artifacts.ts.'
      )
    }
    hash.update(readFileSync(artifactPath))
  }
  return `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`
}
