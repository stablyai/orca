import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseRequiredRelayAddonArches,
  stageRelayWindowsProcessTreeAddon
} from './relay-windows-process-tree-staging.mjs'
import { relayWindowsProcessTreeAddonDefect } from './windows-process-tree-gyp-rebuild.mjs'

const MACHINE = { x64: 0x8664, arm64: 0xaa64 }
const LAUNCHER = 'spawnOutsideJob\0'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function peImage(machine, body) {
  const header = Buffer.alloc(0x90)
  header.write('MZ')
  header.writeUInt32LE(0x80, 0x3c)
  header.write('PE\0\0', 0x80)
  header.writeUInt16LE(machine, 0x84)
  return Buffer.concat([header, Buffer.from(body, 'binary')])
}

function fixture(addons = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relay-process-tree-'))
  roots.push(root)
  const buildDir = join(root, 'build')
  const outDir = join(root, 'out')
  mkdirSync(outDir)
  for (const [arch, bytes] of Object.entries(addons)) {
    mkdirSync(join(buildDir, arch), { recursive: true })
    writeFileSync(join(buildDir, arch, 'windows-process-tree.node'), bytes)
  }
  const logs = []
  const stage = (platform, requiredArches = []) =>
    stageRelayWindowsProcessTreeAddon({
      platform,
      outDir,
      buildDir,
      requiredArches,
      log: (message) => logs.push(message)
    })
  return { buildDir, outDir, logs, stage, staged: join(outDir, 'windows-process-tree.node') }
}

describe('relay windows-process-tree addon check', () => {
  it('accepts only a clean launcher build for the requested machine', () => {
    const { buildDir } = fixture({
      x64: peImage(MACHINE.x64, `ntdll.dll\0${LAUNCHER}`),
      arm64: peImage(MACHINE.x64, LAUNCHER)
    })
    expect(
      relayWindowsProcessTreeAddonDefect(join(buildDir, 'x64/windows-process-tree.node'), 'x64')
    ).toBeNull()
    expect(
      relayWindowsProcessTreeAddonDefect(join(buildDir, 'arm64/windows-process-tree.node'), 'arm64')
    ).toContain('machine 0x8664, not arm64')
  })

  it('rejects a pre-launcher build that is otherwise clean and loadable', () => {
    const { buildDir } = fixture({ x64: peImage(MACHINE.x64, 'NtQueryInformationProcess\0') })
    expect(
      relayWindowsProcessTreeAddonDefect(join(buildDir, 'x64/windows-process-tree.node'), 'x64')
    ).toContain('does not export spawnOutsideJob')
  })

  it('rejects the unpatched command-line reader even when it has the launcher', () => {
    const { buildDir } = fixture({ x64: peImage(MACHINE.x64, `ReadProcessMemory\0${LAUNCHER}`) })
    expect(
      relayWindowsProcessTreeAddonDefect(join(buildDir, 'x64/windows-process-tree.node'), 'x64')
    ).toContain('ReadProcessMemory')
  })
})

describe('staging the relay windows-process-tree addon', () => {
  it('copies a valid addon into each Windows relay and skips other hosts', () => {
    const addon = peImage(MACHINE.arm64, LAUNCHER)
    const { stage, staged } = fixture({ arm64: addon })
    expect(stage('linux-x64', ['all'])).toBe('not-windows')
    expect(existsSync(staged)).toBe(false)
    expect(stage('win32-arm64', ['x64', 'arm64'])).toBe('staged')
    expect(readFileSync(staged)).toEqual(addon)
  })

  it('degrades to the scan when an unrequired addon is missing or stale', () => {
    const { stage, staged, logs } = fixture({ x64: peImage(MACHINE.x64, 'no launcher') })
    expect(stage('win32-x64')).toBe('skipped')
    expect(stage('win32-arm64')).toBe('skipped')
    expect(existsSync(staged)).toBe(false)
    expect(logs.join('\n')).toMatch(/does not export spawnOutsideJob[\s\S]*is missing/)
  })

  it('fails a release build whose required addon is missing or stale', () => {
    const { stage, staged } = fixture({ x64: peImage(MACHINE.x64, 'no launcher') })
    expect(() => stage('win32-x64', ['x64', 'arm64'])).toThrow(/spawnOutsideJob/)
    expect(() => stage('win32-arm64', ['all'])).toThrow(/is missing/)
    expect(existsSync(staged)).toBe(false)
  })

  it('reads the per-arch requirement list', () => {
    expect(parseRequiredRelayAddonArches(undefined)).toEqual([])
    expect(parseRequiredRelayAddonArches(' x64, arm64 ,')).toEqual(['x64', 'arm64'])
  })
})
