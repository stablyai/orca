import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORCAD_VERSION, orcadArtifactFilenames } from '../../src/shared/orcad-artifacts.ts'

export function computeOrcadFullVersion(artifactDir) {
  const hash = createHash('sha256')
  for (const filename of orcadArtifactFilenames()) {
    const artifactPath = join(artifactDir, filename)
    if (!existsSync(artifactPath)) {
      throw new Error(
        `orcad declares ${filename} in ORCAD_ARTIFACTS but never emitted it. Add the build ` +
          'step, or drop it from src/shared/orcad-artifacts.ts.'
      )
    }
    hash.update(readFileSync(artifactPath))
  }
  return `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`
}
