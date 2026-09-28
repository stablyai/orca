import { createRequire } from 'node:module'
import { afterEach, beforeEach } from 'vitest'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cliRuntimeTarget, cliRuntimeFilename } from '../bundled-cli-runtime.cjs'

export async function writeBundledCliRuntimeFixture(
  directory,
  platform,
  arch,
  bytes = 'runtime fixture'
) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, cliRuntimeFilename(platform)), bytes, { mode: 0o755 })
  await copyFile(
    join(import.meta.dirname, '../../resources/licenses/bun/LICENSE.md'),
    join(directory, 'LICENSE.md')
  )
  if (platform === 'win32') {
    await writeBundledConptyFixture(join(directory, 'conpty'), arch)
  }
  await writeFile(
    join(directory, 'runtime.json'),
    JSON.stringify({
      target: cliRuntimeTarget(platform, arch),
      version: ORCAD_BUN_VERSION,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  )
}

// CJS packaging verification reads native require's module cache, outside Vitest's ESM mocks.
const require = createRequire(import.meta.url)
const release = require('../../src/shared/windows-conpty-release.ts')
const originalFiles = structuredClone(release.WINDOWS_CONPTY_FILES)
const originalNuspecHash = release.WINDOWS_CONPTY_ARCHIVE.nuspecSha256
const fixtureArchitectures = new Set()
function mockFixtureHashes(arch) {
  for (const filename of Object.keys(release.WINDOWS_CONPTY_FILES[arch])) {
    release.WINDOWS_CONPTY_FILES[arch][filename] = createHash('sha256')
      .update(`${arch}/${filename} fixture`)
      .digest('hex')
  }
  release.WINDOWS_CONPTY_ARCHIVE.nuspecSha256 = createHash('sha256')
    .update('ConPTY MIT package fixture')
    .digest('hex')
}
beforeEach(() => fixtureArchitectures.forEach(mockFixtureHashes))
afterEach(() => {
  for (const arch of Object.keys(originalFiles)) {
    Object.assign(release.WINDOWS_CONPTY_FILES[arch], originalFiles[arch])
  }
  release.WINDOWS_CONPTY_ARCHIVE.nuspecSha256 = originalNuspecHash
})

export async function writeBundledConptyFixture(directory, arch) {
  fixtureArchitectures.add(arch)
  mockFixtureHashes(arch)
  await mkdir(directory, { recursive: true })
  for (const filename of Object.keys(release.WINDOWS_CONPTY_FILES[arch])) {
    const bytes = `${arch}/${filename} fixture`
    await writeFile(join(directory, filename), bytes)
  }
  const nuspec = 'ConPTY MIT package fixture'
  await writeFile(join(directory, 'Microsoft.Windows.Console.ConPTY.nuspec'), nuspec)
  await copyFile(
    join(import.meta.dirname, '../licenses/windows-conpty-LICENSE.txt'),
    join(directory, 'LICENSE.txt')
  )
  await writeFile(
    join(directory, 'conpty.json'),
    JSON.stringify({
      version: release.WINDOWS_CONPTY_VERSION,
      arch,
      source: release.WINDOWS_CONPTY_ARCHIVE.url,
      archiveSha256: release.WINDOWS_CONPTY_ARCHIVE.sha256,
      files: release.WINDOWS_CONPTY_FILES[arch]
    })
  )
}
