import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cliRuntimeTarget, cliRuntimeFilename } from '../bundled-cli-runtime.cjs'

export async function writeBundledCliRuntimeFixture(directory, platform, arch) {
  const bytes = 'runtime fixture'
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, cliRuntimeFilename(platform)), bytes)
  await copyFile(
    join(import.meta.dirname, '../../resources/licenses/bun/LICENSE.md'),
    join(directory, 'LICENSE.md')
  )
  await writeFile(
    join(directory, 'runtime.json'),
    JSON.stringify({
      target: cliRuntimeTarget(platform, arch),
      version: ORCAD_BUN_VERSION,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  )
}
