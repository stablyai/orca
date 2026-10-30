import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  orcadWindowsCliLauncherSource,
  stageOrcadWindowsCliLauncher
} from './orcad-windows-cli-launcher.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function peImage(machine) {
  const bytes = Buffer.alloc(0x90)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orcad-cli-launcher-'))
  roots.push(root)
  const output = join(root, 'output')
  mkdirSync(output)
  return { root, output }
}

function prepare(root, arch, machine) {
  const source = orcadWindowsCliLauncherSource(root, arch)
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, peImage(machine))
  return source
}

it('stages the prepared launcher for the requested machine at the slot command path', () => {
  const { root, output } = fixture()
  const source = prepare(root, 'arm64', 0xaa64)
  stageOrcadWindowsCliLauncher(root, output, 'win32-arm64', { platform: 'linux' })
  expect(readFileSync(join(output, 'bin', 'orca.exe'))).toEqual(readFileSync(source))
})

it('rejects a launcher built for the wrong machine', () => {
  const { root, output } = fixture()
  prepare(root, 'x64', 0xaa64)
  expect(() => stageOrcadWindowsCliLauncher(root, output, 'win32-x64')).toThrow('machine 0xaa64')
})

it('refuses a missing launcher off Windows and compiles it on Windows', () => {
  const { root, output } = fixture()
  expect(() =>
    stageOrcadWindowsCliLauncher(root, output, 'win32-x64', { platform: 'darwin' })
  ).toThrow('native CLI launcher')
  const compile = vi.fn((_root, arch, path) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, peImage(arch === 'x64' ? 0x8664 : 0xaa64))
  })
  stageOrcadWindowsCliLauncher(root, output, 'win32-x64', { platform: 'win32' }, compile)
  expect(compile).toHaveBeenCalledWith(root, 'x64', orcadWindowsCliLauncherSource(root, 'x64'))
  expect(readFileSync(join(output, 'bin', 'orca.exe'))).toEqual(peImage(0x8664))
})

it('ignores POSIX targets', () => {
  expect(() => stageOrcadWindowsCliLauncher('absent', 'absent', 'linux-x64-glibc')).not.toThrow()
})
