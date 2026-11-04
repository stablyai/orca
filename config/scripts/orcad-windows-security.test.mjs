import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { windowsSecurityAddonOutput } from './build-windows-security-addon.mjs'
import { stageOrcadWindowsSecurity } from './orcad-windows-security.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function peBytes(machine) {
  const bytes = Buffer.alloc(0x90)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orcad-windows-security-'))
  roots.push(root)
  const output = join(root, 'output')
  mkdirSync(output)
  const write = (arch, machine) => {
    const source = windowsSecurityAddonOutput(root, arch)
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, peBytes(machine))
    return source
  }
  return { root, output, write }
}

it('stages the addon for each Windows architecture after checking its machine', () => {
  const { root, output, write } = fixture()
  const x64 = write('x64', 0x8664)
  stageOrcadWindowsSecurity(root, output, 'win32-x64')
  expect(readFileSync(join(output, 'windows-security.node'))).toEqual(readFileSync(x64))

  const arm64 = write('arm64', 0xaa64)
  stageOrcadWindowsSecurity(root, output, 'win32-arm64')
  expect(readFileSync(join(output, 'windows-security.node'))).toEqual(readFileSync(arm64))
})

it('rejects a binary built for the wrong architecture', () => {
  const { root, output, write } = fixture()
  write('arm64', 0x8664)
  expect(() => stageOrcadWindowsSecurity(root, output, 'win32-arm64')).toThrow('machine 0x8664')
  expect(existsSync(join(output, 'windows-security.node'))).toBe(false)
})

it('fails the build off Windows when the addon was never built, and compiles it on Windows', () => {
  const { root, output, write } = fixture()
  expect(() => stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'linux' })).toThrow(
    'build-windows-security-addon.mjs --arch=x64'
  )

  const compile = vi.fn((compileRoot, arch) => write(arch, 0x8664))
  stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'win32' }, compile)
  expect(compile).toHaveBeenCalledWith(root, 'x64', {})
  expect(existsSync(join(output, 'windows-security.node'))).toBe(true)
})

it('does not stage an addon when the child builder fails', () => {
  const { root, output } = fixture()
  const run = vi.fn(() => ({ code: 1 }))
  expect(() =>
    stageOrcadWindowsSecurity(root, output, 'win32-x64', { platform: 'win32' }, undefined, { run })
  ).toThrow('failed with exit 1')
  expect(existsSync(join(output, 'windows-security.node'))).toBe(false)
})
