import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installPrebuiltSlot,
  readPrebuiltSlotManifest,
  resolveOrcadPrebuildsDir,
  type PrebuiltSlotEntry
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

const WIN32_X64: NativeHostAbi = {
  platform: 'win32',
  arch: 'x64',
  libc: 'none',
  glibcVersion: null,
  nodeAbi: '137'
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

/** Stage `files` under `<prebuilds>/<slot>` and record them in a schema 2 manifest. */
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
    stageSlot(
      prebuilds,
      'darwin-arm64',
      { platform: 'darwin', arch: 'arm64', libc: 'none', glibc: null, napi: 8 },
      { 'pty.node': 'binary', 'spawn-helper': 'helper' }
    )

    const outcome = installPrebuiltSlot({
      abi: DARWIN_ARM64,
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

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
    stageSlot(prebuilds, 'linux-x64-glibc', LINUX_GLIBC_ENTRY, { 'pty.node': 'binary' })

    const outcome = installPrebuiltSlot({
      abi: LINUX_GLIBC,
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

    expect(outcome).toEqual({ installed: true, slot: 'linux-x64-glibc', spawnHelper: false })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(true)
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'spawn-helper'))).toBe(false)
  })

  it('installs the Windows ConPTY runtime beside conpty.node', () => {
    // conpty.node resolves conpty\\conpty.dll relative to its own path; flattening the
    // directory would fail every useConptyDll spawn.
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(
      prebuilds,
      'win32-x64',
      { platform: 'win32', arch: 'x64', libc: 'none', glibc: null, napi: 8 },
      {
        'conpty.node': 'conpty',
        'conpty_console_list.node': 'list',
        'conpty/conpty.dll': 'dll',
        'conpty/OpenConsole.exe': 'exe'
      }
    )

    const outcome = installPrebuiltSlot({
      abi: WIN32_X64,
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

    expect(outcome).toEqual({ installed: true, slot: 'win32-x64', spawnHelper: false })
    for (const file of ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll']) {
      expect(existsSync(join(nodePtyDir, 'build', 'Release', ...file.split('/')))).toBe(true)
    }
  })

  it('will not load a glibc slot on a musl host', () => {
    // node-pty's own loader cannot tell these apart; the slot name is the only thing that can.
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlot(prebuilds, 'linux-x64-glibc', LINUX_GLIBC_ENTRY, { 'pty.node': 'binary' })

    const outcome = installPrebuiltSlot({
      abi: { ...LINUX_GLIBC, libc: 'musl' },
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

    expect(outcome).toEqual({ installed: false, slot: 'linux-x64-musl', why: 'no-slot' })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(false)
  })

  it('refuses a glibc build filed under the musl slot name', () => {
    // A mislabelled CI run (`--slot=linux-x64-musl` in a glibc container) must not reach
    // Alpine's loader: the recorded libc, not the directory name, decides.
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

  it('gates on N-API, so a newer Node ABI still installs and an older N-API does not', () => {
    // NODE_MODULE_VERSION differs between the pinned Node and a host Node 18; N-API is the
    // contract that lets one build serve both.
    const prebuilds = temp()
    stageSlot(prebuilds, 'linux-x64-glibc', LINUX_GLIBC_ENTRY, { 'pty.node': 'binary' })

    expect(
      installPrebuiltSlot({
        abi: { ...LINUX_GLIBC, nodeAbi: '108' },
        nodePtyDir: temp(),
        prebuildsDir: prebuilds,
        hostNapi: 8
      })
    ).toMatchObject({ installed: true })

    const nodePtyDir = temp()
    expect(
      installPrebuiltSlot({ abi: LINUX_GLIBC, nodePtyDir, prebuildsDir: prebuilds, hostNapi: 7 })
    ).toMatchObject({ installed: false, why: 'napi-unsupported' })
    expect(existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))).toBe(false)
  })

  it('refuses a glibc slot on a host older than the slot needs', () => {
    const prebuilds = temp()
    stageSlot(
      prebuilds,
      'linux-x64-glibc',
      { ...LINUX_GLIBC_ENTRY, glibc: '2.31' },
      { 'pty.node': 'binary' }
    )

    expect(
      installPrebuiltSlot({
        abi: { ...LINUX_GLIBC, glibcVersion: '2.28' },
        nodePtyDir: temp(),
        prebuildsDir: prebuilds,
        hostNapi: 10
      })
    ).toMatchObject({ installed: false, why: 'glibc-too-old' })
    // An unread version is not evidence of an old glibc.
    expect(
      installPrebuiltSlot({
        abi: { ...LINUX_GLIBC, glibcVersion: null },
        nodePtyDir: temp(),
        prebuildsDir: prebuilds,
        hostNapi: 10
      })
    ).toMatchObject({ installed: true })
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

  it('refuses a matrix with no schema 2 manifest instead of installing unchecked binaries', () => {
    const prebuilds = temp()
    mkdirSync(join(prebuilds, 'linux-x64-glibc'), { recursive: true })
    writeFileSync(join(prebuilds, 'linux-x64-glibc', 'pty.node'), 'binary')
    writeFileSync(
      join(prebuilds, 'manifest.json'),
      JSON.stringify({ module: 'node-pty', version: '1.1.0', nodeAbi: '115', slots: [] })
    )

    expect(
      installPrebuiltSlot({
        abi: LINUX_GLIBC,
        nodePtyDir: temp(),
        prebuildsDir: prebuilds,
        hostNapi: 10
      })
    ).toMatchObject({ installed: false, why: 'no-manifest' })
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

  it('rejects file paths that would escape build/Release', () => {
    const prebuilds = temp()
    writeFileSync(
      join(prebuilds, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        module: 'node-pty',
        version: '1.1.0',
        napi: 8,
        slots: {
          'linux-x64-glibc': { ...LINUX_GLIBC_ENTRY, files: { '../evil.node': sha256('x') } }
        }
      })
    )
    expect(readPrebuiltSlotManifest(prebuilds)).toBeNull()
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

  it('keeps the default slot on a host that meets its floor', () => {
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlots(prebuilds, {
      'linux-x64-glibc': { glibc: '2.28', bytes: 'default' },
      'linux-x64-glibc217': { glibc: '2.17', bytes: 'compat' }
    })

    const outcome = installPrebuiltSlot({
      abi: LINUX_GLIBC,
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

    expect(outcome).toMatchObject({ installed: true, slot: 'linux-x64-glibc' })
    expect(installed(nodePtyDir)).toBe('default')
  })

  it('reports the default slot refusal when the compat slot cannot load either', () => {
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlots(prebuilds, {
      'linux-x64-glibc': { glibc: '2.28', bytes: 'default' },
      'linux-x64-glibc217': { glibc: '2.17', bytes: 'compat' }
    })

    const outcome = installPrebuiltSlot({
      abi: { ...LINUX_GLIBC, glibcVersion: '2.12' },
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

    expect(outcome).toMatchObject({
      installed: false,
      slot: 'linux-x64-glibc',
      why: 'glibc-too-old'
    })
  })

  it('never offers the x64 compat slot to an arm64 host', () => {
    const prebuilds = temp()
    const nodePtyDir = temp()
    stageSlots(prebuilds, { 'linux-x64-glibc217': { glibc: '2.17', bytes: 'compat' } })

    const outcome = installPrebuiltSlot({
      abi: { ...LINUX_GLIBC, arch: 'arm64', glibcVersion: '2.17' },
      nodePtyDir,
      prebuildsDir: prebuilds,
      hostNapi: 10
    })

    expect(outcome).toEqual({ installed: false, slot: 'linux-arm64-glibc', why: 'no-slot' })
  })
})
