import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION,
  orcadArtifactFilenames,
  orcadMobileWebAssetFilenames
} from '../../../shared/remote-runtime/orcad-distribution/orcad-artifacts'
import {
  COMPAT_SERVER_TARGETS,
  SERVER_TARGETS
} from '../../../shared/node-runtime/node-runtime-pin'
import { orcadAgentBrowserNativeName } from '../../../shared/remote-runtime/orcad-distribution/orcad-agent-browser-name'

/** Hash installed bytes in the build's order; a version marker is not proof of delivery.
 * The optional agent-browser is listed for startup qualification but not hashed, so a client that
 * bundles it and one that does not still share one install id (#45450). */
export async function readOrcadArtifactIdentity(directory: string): Promise<string> {
  const hash = createHash('sha256')
  const { filenames } = await readSlotArtifacts(directory)
  for (const filename of filenames) {
    for await (const chunk of createReadStream(join(directory, filename))) {
      hash.update(chunk)
    }
  }
  return `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`
}

/** The installed files startup qualification stats, in the build's order. */
export async function listOrcadArtifactFilenames(directory: string): Promise<string[]> {
  const { target, filenames } = await readSlotArtifacts(directory)
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
  if (existsSync(join(directory, browser))) {
    filenames.push(browser)
  }
  return filenames
}

/** Required slot files. The browser binary is added only by the qualification listing. */
async function readSlotArtifacts(
  directory: string
): Promise<{ target: string; filenames: string[] }> {
  const target = z
    .enum([...SERVER_TARGETS, ...COMPAT_SERVER_TARGETS])
    .parse((await readFile(join(directory, ORCAD_SERVER_TARGET_FILENAME), 'utf8')).trim())
  return {
    target,
    filenames: orcadArtifactFilenames(
      target,
      orcadMobileWebAssetFilenames(
        await readFile(join(directory, ORCAD_MOBILE_WEB_MANIFEST), 'utf8')
      )
    )
  }
}
