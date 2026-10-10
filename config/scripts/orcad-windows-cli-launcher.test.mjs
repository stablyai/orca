import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME } from '../../src/shared/orcad-artifacts.ts'
import { stageOrcadWindowsCliLauncher } from './orcad-windows-cli-launcher.mjs'
import { peImage } from './windows-pe-image-fixture.mjs'

// Staging is checked on a non-Windows host so the test never compiles the launcher.
const crossHost = { platform: 'linux' }

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(arch, image) {
  const root = mkdtempSync(join(tmpdir(), 'orcad-cli-launcher-'))
  roots.push(root)
  const output = join(root, 'output')
  if (image) {
    mkdirSync(join(root, '.build/windows-cli-launcher', arch), { recursive: true })
    writeFileSync(join(root, '.build/windows-cli-launcher', arch, 'orca.exe'), image)
  }
  return { root, output }
}

it('stages the launcher built for the target machine', () => {
  const image = peImage({ arch: 'arm64' })
  const { root, output } = fixture('arm64', image)
  stageOrcadWindowsCliLauncher(root, output, 'win32-arm64', crossHost)
  expect(readFileSync(join(output, ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME))).toEqual(image)
})

it('rejects a launcher built for another machine', () => {
  const { root, output } = fixture('x64', peImage({ arch: 'arm64' }))
  expect(() => stageOrcadWindowsCliLauncher(root, output, 'win32-x64', crossHost)).toThrow(
    'CLI launcher has machine 0xaa64'
  )
})

it('names the build command when the launcher artifact is missing', () => {
  const { root, output } = fixture('x64')
  expect(() => stageOrcadWindowsCliLauncher(root, output, 'win32-x64', crossHost)).toThrow(
    'build-windows-cli-launcher.mjs --arch x64'
  )
})

it('ignores non-Windows targets', () => {
  const { root, output } = fixture('x64')
  expect(() => stageOrcadWindowsCliLauncher(root, output, 'linux-x64', crossHost)).not.toThrow()
})
