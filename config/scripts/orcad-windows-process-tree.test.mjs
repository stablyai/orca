import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { stageOrcadWindowsProcessTree } from './orcad-windows-process-tree.mjs'
import { windowsProcessTreeAddonPath } from './windows-process-tree-gyp-rebuild.mjs'

const windowsHost = { platform: 'win32', arch: 'x64' }

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(machine = 0x8664, suffix = '') {
  const root = mkdtempSync(join(tmpdir(), 'orcad-process-reader-'))
  roots.push(root)
  const source = join(root, '.build/windows-process-tree/x64')
  const output = join(root, 'output')
  mkdirSync(source, { recursive: true })
  mkdirSync(output)
  const bytes = Buffer.alloc(0x90)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(machine, 0x84)
  const file = join(source, 'windows-process-tree.node')
  writeFileSync(file, Buffer.concat([bytes, Buffer.from(suffix)]))
  return { root, output, file }
}

function installedFixture(machine = 0x8664, suffix = '') {
  const prepared = fixture(machine, suffix)
  const packageDir = join(prepared.root, 'node_modules', '@vscode', 'windows-process-tree')
  mkdirSync(join(packageDir, 'build', 'Release'), { recursive: true })
  const installed = windowsProcessTreeAddonPath(packageDir)
  writeFileSync(installed, readFileSync(prepared.file))
  rmSync(prepared.file)
  return { ...prepared, installed }
}

it('stages only a clean reader for the requested machine', () => {
  const { root, output, file } = fixture()
  stageOrcadWindowsProcessTree(root, output, 'win32-x64')
  expect(readFileSync(join(output, 'windows-process-tree.node'))).toEqual(readFileSync(file))
})

it('rejects an unpatched reader even when its architecture matches', () => {
  const { root, output } = fixture(0x8664, 'ReadProcessMemory')
  expect(() => stageOrcadWindowsProcessTree(root, output, 'win32-x64')).toThrow(
    'patched process reader'
  )
})

it('rejects wrong architecture and absent artifacts', () => {
  const { root, output } = fixture(0xaa64)
  expect(() => stageOrcadWindowsProcessTree(root, output, 'win32-x64')).toThrow('machine 0xaa64')
  expect(() => stageOrcadWindowsProcessTree(root, output, 'win32-arm64')).toThrow(
    'patched process reader'
  )
})

it('keeps POSIX builds independent of Windows build tools', () => {
  expect(() => stageOrcadWindowsProcessTree('absent', 'absent', 'linux-x64-glibc')).not.toThrow()
})

it('reuses the checked native addon from an ordinary Windows host install', () => {
  const { root, output, installed } = installedFixture()
  stageOrcadWindowsProcessTree(root, output, 'win32-x64', windowsHost)
  expect(readFileSync(join(output, 'windows-process-tree.node'))).toEqual(readFileSync(installed))
})

it.each([
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'arm64' }
])('does not reuse host installation for a different target: %j', (host) => {
  const { root, output } = installedFixture()
  expect(() => stageOrcadWindowsProcessTree(root, output, 'win32-x64', host)).toThrow(
    'patched process reader'
  )
})

it('requires the installed fallback to have the matching architecture and patch', () => {
  const { root, output, installed } = installedFixture(0xaa64)
  expect(() => stageOrcadWindowsProcessTree(root, output, 'win32-x64', windowsHost)).toThrow(
    'machine 0xaa64'
  )
  writeFileSync(installed, 'ReadProcessMemory')
  expect(() => stageOrcadWindowsProcessTree(root, output, 'win32-x64', windowsHost)).toThrow(
    'patched process reader'
  )
  rmSync(installed)
  expect(() => stageOrcadWindowsProcessTree(root, output, 'win32-x64', windowsHost)).toThrow(
    'patched process reader'
  )
})

it('prefers explicit architecture builds and refuses to mask a stale one', () => {
  const { root, output, file, installed } = installedFixture()
  const staged = Buffer.concat([readFileSync(installed), Buffer.from('staged')])
  writeFileSync(file, staged)
  stageOrcadWindowsProcessTree(root, output, 'win32-x64', windowsHost)
  expect(readFileSync(join(output, 'windows-process-tree.node'))).toEqual(staged)
  writeFileSync(file, 'ReadProcessMemory')
  expect(() => stageOrcadWindowsProcessTree(root, output, 'win32-x64', windowsHost)).toThrow(
    'patched process reader'
  )
})
