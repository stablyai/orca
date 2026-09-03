import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installPrebuiltSlot,
  readPrebuiltSlotManifest,
  resolveOrcadPrebuildsDir
} from './node-pty-prebuilt-slot'
import type { NativeHostAbi } from './native-host-abi'

const LINUX_GLIBC: NativeHostAbi = {
  platform: 'linux',
  arch: 'x64',
  libc: 'glibc',
  glibcVersion: '2.31',
  nodeAbi: '127'
}

const DARWIN_ARM64: NativeHostAbi = {
  platform: 'darwin',
  arch: 'arm64',
  libc: 'none',
  glibcVersion: null,
  nodeAbi: '127'
}

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-slot-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.ORCA_ORCAD_PREBUILDS_DIR
})

const stageSlot = (prebuilds: string, slot: string): void => {
  mkdirSync(join(prebuilds, slot), { recursive: true })
  writeFileSync(join(prebuilds, slot, 'pty.node'), 'binary')
  writeFileSync(join(prebuilds, slot, 'spawn-helper'), 'helper')
}

describe('resolveOrcadPrebuildsDir', () => {
  it('looks beside the running bundle', () => {
    expect(resolveOrcadPrebuildsDir('/opt/orcad/orcad.js')).toBe(join('/opt/orcad', 'prebuilds'))
  })

  it('honours an explicit override', () => {
    process.env.ORCA_ORCAD_PREBUILDS_DIR = '/custom/prebuilds'
    expect(resolveOrcadPrebuildsDir('/opt/orcad/orcad.js')).toBe('/custom/prebuilds')
  })
})

describe('installPrebuiltSlot', () => {
  it('installs the slot binary and spawn-helper into build/Release on macOS', () => {
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(prebuilds, 'darwin-arm64')

    const outcome = installPrebuiltSlot({ abi: DARWIN_ARM64, nodePtyDir, prebuildsDir: prebuilds })

    expect(outcome).toEqual({ installed: true, slot: 'darwin-arm64', spawnHelper: true })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(true)
    // Without the executable bit every spawn fails EACCES at the moment a user opens a terminal.
    const helper = statSync(join(nodePtyDir, 'build', 'Release', 'spawn-helper'))
    expect(helper.mode & 0o111).not.toBe(0)
  })

  it('installs a Linux slot without claiming a spawn-helper it never execs', () => {
    // node-pty builds spawn-helper only under binding.gyp's OS=="mac"; reporting one off
    // macOS is what made every Linux orcad boot degraded on spawn_helper_missing (#17844).
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(prebuilds, 'linux-x64-glibc')

    const outcome = installPrebuiltSlot({ abi: LINUX_GLIBC, nodePtyDir, prebuildsDir: prebuilds })

    expect(outcome).toEqual({ installed: true, slot: 'linux-x64-glibc', spawnHelper: false })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(true)
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'spawn-helper'))).toBe(false)
  })

  it('will not load a glibc slot on a musl host', () => {
    // node-pty's own loader cannot tell these apart; the slot name is the only thing that can.
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(prebuilds, 'linux-x64-glibc')

    const outcome = installPrebuiltSlot({
      abi: { ...LINUX_GLIBC, libc: 'musl' },
      nodePtyDir,
      prebuildsDir: prebuilds
    })

    expect(outcome).toEqual({ installed: false, slot: 'linux-x64-musl', why: 'no-slot' })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(false)
  })

  it('refuses an ABI-mismatched matrix instead of installing a binary that cannot load', () => {
    // Installing it would turn "no prebuilt for this host" into a loader failure that
    // reads as a corrupt install.
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(prebuilds, 'linux-x64-glibc')
    writeFileSync(
      join(prebuilds, 'manifest.json'),
      JSON.stringify({ module: 'node-pty', version: '1.1.0', nodeAbi: '115', slots: [] })
    )

    const outcome = installPrebuiltSlot({ abi: LINUX_GLIBC, nodePtyDir, prebuildsDir: prebuilds })

    expect(outcome).toMatchObject({ installed: false, why: 'abi-mismatch' })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(false)
  })

  it('reports a missing prebuilds directory distinctly from a missing slot', () => {
    // They mean different things: no matrix shipped at all, versus a matrix with a hole.
    expect(
      installPrebuiltSlot({
        abi: LINUX_GLIBC,
        nodePtyDir: temp(),
        prebuildsDir: join(temp(), 'absent')
      })
    ).toEqual({ installed: false, slot: 'linux-x64-glibc', why: 'no-prebuilds-dir' })
  })
})

describe('readPrebuiltSlotManifest', () => {
  it('returns null for absent or malformed manifests rather than a half-built object', () => {
    const prebuilds = temp()
    expect(readPrebuiltSlotManifest(prebuilds)).toBeNull()
    writeFileSync(join(prebuilds, 'manifest.json'), '{ not json')
    expect(readPrebuiltSlotManifest(prebuilds)).toBeNull()
    writeFileSync(join(prebuilds, 'manifest.json'), JSON.stringify({ version: '1.1.0' }))
    expect(readPrebuiltSlotManifest(prebuilds)).toBeNull()
  })
})
