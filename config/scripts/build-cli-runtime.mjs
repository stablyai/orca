import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeRuntime } from './build-orcad-bun.mjs'
import { ORCAD_BUN_RELEASE_ASSETS, ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import { cliRuntimeTarget, cliRuntimeFilename } from '../bundled-cli-runtime.cjs'

const root = resolve(import.meta.dirname, '../..')

export async function buildCliRuntime(platform, arch, projectDir = root) {
  const target = cliRuntimeTarget(platform, arch)
  const directory = join(projectDir, 'out', 'cli-runtime', `${platform}-${arch}`)
  mkdirSync(directory, { recursive: true })
  await materializeRuntime(target, join(directory, cliRuntimeFilename(platform)))
  copyFileSync(join(root, 'resources/licenses/bun/LICENSE.md'), join(directory, 'LICENSE.md'))
  writeFileSync(
    join(directory, 'runtime.json'),
    `${JSON.stringify({
      target,
      version: ORCAD_BUN_VERSION,
      sha256: ORCAD_BUN_RELEASE_ASSETS[target].executableSha256
    })}\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = (name) => {
    const index = process.argv.indexOf(name)
    if (index === -1) {
      return undefined
    }
    const value = process.argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`)
    }
    return value
  }
  const platform = option('--platform') ?? process.platform
  const selectedArch = option('--arch')
  for (const arch of selectedArch ? [selectedArch] : ['x64', 'arm64']) {
    await buildCliRuntime(platform, arch)
  }
}
