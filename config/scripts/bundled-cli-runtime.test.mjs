import { writeBundledConptyFixture } from './bundled-cli-runtime-fixture.mjs'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  cliRuntimeTarget,
  cliRuntimeFilename,
  cliRuntimeExtraResource,
  verifyWindowsConptyDirectory,
  assertBundledCliRuntimeBuilt
} from '../bundled-cli-runtime.cjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it.each(['darwin', 'linux', 'win32'])(
  'verifies the exact %s architecture and executable bytes',
  async (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cli-runtime-'))
    roots.push(root)
    const directory = join(root, 'out/cli-runtime', `${platform}-arm64`)
    mkdirSync(directory, { recursive: true })
    const bytes = Buffer.from('test runtime')
    const binary = join(directory, cliRuntimeFilename(platform))
    writeFileSync(binary, bytes)
    const license = join(directory, 'LICENSE.md')
    const sourceLicense = join(import.meta.dirname, '../../resources/licenses/bun/LICENSE.md')
    copyFileSync(sourceLicense, license)
    writeFileSync(
      join(directory, 'runtime.json'),
      JSON.stringify({
        target: cliRuntimeTarget(platform, 'arm64'),
        version: ORCAD_BUN_VERSION,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    )
    if (platform === 'win32') {
      await writeBundledConptyFixture(join(directory, 'conpty'), 'arm64')
    }
    expect(() => assertBundledCliRuntimeBuilt(platform, 3, root)).not.toThrow()
    expect(() => assertBundledCliRuntimeBuilt(platform, 1, root)).toThrow('build-cli-runtime.mjs')
    const manifestPath = join(directory, 'runtime.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.0.0' }))
    expect(() => assertBundledCliRuntimeBuilt(platform, 3, root)).toThrow('damaged')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    unlinkSync(license)
    expect(() => assertBundledCliRuntimeBuilt(platform, 3, root)).toThrow('damaged')
    writeFileSync(license, 'truncated notice')
    expect(() => assertBundledCliRuntimeBuilt(platform, 3, root)).toThrow('damaged')
    copyFileSync(sourceLicense, license)
    writeFileSync(binary, 'corrupt')
    expect(() => assertBundledCliRuntimeBuilt(platform, 3, root)).toThrow('damaged')
  }
)

it('packages only the selected platform/architecture and rejects unsupported targets', () => {
  expect(cliRuntimeExtraResource('win32')).toEqual({
    from: 'out/cli-runtime/win32-${arch}',
    to: 'cli-runtime',
    filter: ['bun-runtime.exe', 'runtime.json', 'LICENSE.md', 'conpty/**']
  })
  expect(cliRuntimeTarget('linux', 'x64')).toBe('linux-x64-glibc')
  expect(() => cliRuntimeTarget('linux', 'ia32')).toThrow('Unsupported')
  expect(() => cliRuntimeTarget('freebsd', 'x64')).toThrow('Unsupported')
})

it.each([
  'conpty.dll',
  'OpenConsole.exe',
  'LICENSE.txt',
  'Microsoft.Windows.Console.ConPTY.nuspec'
])('rejects missing and corrupted provider %s independently of the manifest', async (filename) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-conpty-package-'))
  roots.push(root)
  await writeBundledConptyFixture(root, 'x64')
  expect(() => verifyWindowsConptyDirectory(root, 'x64')).not.toThrow()
  expect(() => verifyWindowsConptyDirectory(root, 'arm64')).toThrow('manifest')
  unlinkSync(join(root, filename))
  expect(() => verifyWindowsConptyDirectory(root, 'x64')).toThrow()
  writeFileSync(join(root, filename), 'corrupt')
  const manifest = JSON.parse(readFileSync(join(root, 'conpty.json'), 'utf8'))
  manifest.files[filename] = createHash('sha256').update('corrupt').digest('hex')
  writeFileSync(join(root, 'conpty.json'), JSON.stringify(manifest))
  expect(() => verifyWindowsConptyDirectory(root, 'x64')).toThrow()
})
