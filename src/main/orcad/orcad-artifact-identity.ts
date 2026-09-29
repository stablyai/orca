import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_VERSION,
  orcadArtifactFilenames,
  orcadArtifactHashPrefix
} from '../../shared/orcad-artifacts'
import { ORCAD_BUN_TARGETS } from '../../shared/orcad-bun-runtime'
import { orcadAgentBrowserNativeName } from '../../shared/orcad-agent-browser-name'

/** Hash installed bytes in the build's order; a version marker is not proof of delivery. */
export async function readOrcadArtifactIdentity(directory: string): Promise<string> {
  const target = z
    .enum(ORCAD_BUN_TARGETS)
    .parse((await readFile(join(directory, ORCAD_BUILD_TARGET_FILENAME), 'utf8')).trim())
  const platform = target.startsWith('win32-')
    ? 'win32'
    : target.startsWith('darwin-')
      ? 'darwin'
      : 'linux'
  const browser = orcadAgentBrowserNativeName(
    platform,
    target.split('-')[1] ?? '',
    target.endsWith('-musl') ? 'musl' : 'glibc'
  )
  const filenames = orcadArtifactFilenames(target)
  if (existsSync(join(directory, browser))) {
    filenames.push(browser)
  }
  const hash = createHash('sha256').update(orcadArtifactHashPrefix(target))
  for (const filename of filenames) {
    for await (const chunk of createReadStream(join(directory, filename))) {
      hash.update(chunk)
    }
  }
  return `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`
}
