import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPrebuiltSlot, type PrebuiltSlotEntry } from './node-pty-prebuilt-slot'
import type { NativeHostAbi } from './native-host-abi'

const LINUX_GLIBC: NativeHostAbi = {
  platform: 'linux',
  arch: 'x64',
  libc: 'glibc',
  glibcVersion: '2.31',
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

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const stageSlot = (
  prebuilds: string,
  slot: string,
  entry: Omit<PrebuiltSlotEntry, 'files'>,
  files: Record<string, string>
): void => {
  for (const [file, contents] of Object.entries(files)) {
    const path = join(prebuilds, slot, ...file.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  writeFileSync(
    join(prebuilds, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      module: 'node-pty',
      version: '1.1.0',
      napi: 8,
      slots: {
        [slot]: {
          ...entry,
          files: Object.fromEntries(
            Object.entries(files).map(([file, contents]) => [file, sha256(contents)])
          )
        }
      }
    })
  )
}

const LINUX_GLIBC_ENTRY = {
  platform: 'linux',
  arch: 'x64',
  libc: 'glibc',
  glibc: '2.17',
  napi: 8
} as const

describe('installPrebuiltSlot', () => {
  it('refuses a glibc build filed under the musl slot name', () => {
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(prebuilds, 'linux-x64-musl', LINUX_GLIBC_ENTRY, { 'pty.node': 'binary' })

    const outcome = installPrebuiltSlot({
      abi: { ...LINUX_GLIBC, libc: 'musl', glibcVersion: null },
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

    expect(outcome).toMatchObject({
      installed: false,
      slot: 'linux-x64-musl',
      why: 'libc-mismatch'
    })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(false)
  })

  it('refuses a slot built for another architecture', () => {
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(
      prebuilds,
      'linux-x64-glibc',
      { ...LINUX_GLIBC_ENTRY, arch: 'arm64' },
      { 'pty.node': 'binary' }
    )

    expect(
      installPrebuiltSlot({ abi: LINUX_GLIBC, nodePtyDir, prebuildsDir: prebuilds, hostNapi: 10 })
    ).toMatchObject({ installed: false, why: 'arch-mismatch' })
  })

  it('refuses a slot whose files do not match the manifest hashes', () => {
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(prebuilds, 'linux-x64-glibc', LINUX_GLIBC_ENTRY, { 'pty.node': 'binary' })
    writeFileSync(join(prebuilds, 'linux-x64-glibc', 'pty.node'), 'torn')

    expect(
      installPrebuiltSlot({ abi: LINUX_GLIBC, nodePtyDir, prebuildsDir: prebuilds, hostNapi: 10 })
    ).toMatchObject({ installed: false, why: 'hash-mismatch' })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(false)
  })
})

describe('installPrebuiltSlot compat slot (design D6 rung B)', () => {
  const stageSlots = (
    prebuilds: string,
    slots: Record<string, { glibc: string; bytes: string }>
  ) => {
    const manifestSlots: Record<string, PrebuiltSlotEntry> = {}
    for (const [slot, { glibc, bytes }] of Object.entries(slots)) {
      const path = join(prebuilds, slot, 'pty.node')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
      manifestSlots[slot] = { ...LINUX_GLIBC_ENTRY, glibc, files: { 'pty.node': sha256(bytes) } }
    }
    writeFileSync(
      join(prebuilds, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        module: 'node-pty',
        version: '1.1.0',
        napi: 8,
        slots: manifestSlots
      })
    )
  }
  const installed = (nodePtyDir: string): string =>
    readFileSync(join(nodePtyDir, 'build', 'Release', 'pty.node'), 'utf8')

  it('takes the compat slot when the host glibc is below the default slot floor', () => {
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlots(prebuilds, {
      'linux-x64-glibc': { glibc: '2.28', bytes: 'default' },
      'linux-x64-glibc217': { glibc: '2.17', bytes: 'compat' }
    })

    const outcome = installPrebuiltSlot({
      abi: { ...LINUX_GLIBC, glibcVersion: '2.17' },
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

    expect(outcome).toEqual({ installed: true, slot: 'linux-x64-glibc217', spawnHelper: false })
    expect(installed(nodePtyDir)).toBe('compat')
  })
})
