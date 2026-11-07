import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import * as buildInputs from '../../node-runtime/archive-identity/update-node-runtime-pin.mjs'
import * as windowsToolchain from '../../native-build/windows/initialize-windows-native-toolchain.mjs'
import * as handshakePatch from './iroh-handshake-deadline.mjs'
import {
  buildIrohPrebuild,
  fetchIrohBuildInput,
  IROH_BUILD_IDENTITY,
  IROH_PREBUILD_FILES,
  verifyIrohPrebuild
} from './iroh-prebuild.mjs'

vi.mock('@orca/process-host', () => ({ runProcessSync: vi.fn() }))

const targets = [
  [
    'linux-x64-glibc',
    'iroh/iroh.linux-x64-gnu.node',
    'x86_64-unknown-linux-gnu',
    'libnumber0_iroh.so'
  ],
  [
    'linux-arm64-glibc',
    'iroh/iroh.linux-arm64-gnu.node',
    'aarch64-unknown-linux-gnu',
    'libnumber0_iroh.so'
  ],
  [
    'linux-x64-musl',
    'iroh/iroh.linux-x64-musl.node',
    'x86_64-unknown-linux-musl',
    'libnumber0_iroh.so'
  ],
  [
    'linux-arm64-musl',
    'iroh/iroh.linux-arm64-musl.node',
    'aarch64-unknown-linux-musl',
    'libnumber0_iroh.so'
  ],
  ['darwin-arm64', 'iroh/iroh.darwin-arm64.node', 'aarch64-apple-darwin', 'libnumber0_iroh.dylib'],
  ['win32-x64', 'iroh/iroh.win32-x64-msvc.node', 'x86_64-pc-windows-msvc', 'number0_iroh.dll'],
  ['win32-arm64', 'iroh/iroh.win32-arm64-msvc.node', 'aarch64-pc-windows-msvc', 'number0_iroh.dll']
]

const dirs = []

/** Allocates an isolated slot/cache directory removed after each test. */
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'iroh-prebuild-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(runProcessSync).mockReset()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Makes only the ELF64 little-endian header the verifier needs; not a loadable addon. */
function elf64(machine) {
  const bytes = Buffer.alloc(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(machine, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.writeUInt16LE(64, 52)
  return bytes
}

/** Header fixtures deliberately describe the target library format without being loadable addons. */
function nativeHeader(slot, arch = slot.split('-')[1]) {
  if (slot.startsWith('linux-')) {
    return elf64(arch === 'x64' ? 62 : 183)
  }
  if (slot.startsWith('darwin-')) {
    const bytes = Buffer.alloc(32)
    bytes.writeUInt32LE(0xfeedfacf)
    bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    bytes.writeUInt32LE(6, 12)
    return bytes
  }
  const bytes = Buffer.alloc(256)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64)
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68)
  bytes.writeUInt16LE(112, 84)
  bytes.writeUInt16LE(0x2000, 86)
  bytes.writeUInt16LE(0x20b, 88)
  return bytes
}

/** Writes target-header bytes and a detached identity so rejection cases can mutate either. */
function fixture(slot = 'linux-x64-glibc') {
  const slotDir = temp()
  const relative = IROH_PREBUILD_FILES[slot]
  const native = join(slotDir, relative)
  mkdirSync(dirname(native), { recursive: true })
  writeFileSync(native, nativeHeader(slot))
  const entry = {
    files: { [relative]: createHash('sha256').update(readFileSync(native)).digest('hex') },
    iroh: structuredClone(IROH_BUILD_IDENTITY)
  }
  return { slotDir, slot, entry, version: '1.1.0', relative, native }
}

/** Serves actual build-input bytes over loopback and always closes its socket. */
async function withBuildInput(bytes, run) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.end(bytes)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await run(`http://127.0.0.1:${server.address().port}/input.tar.xz`, requests)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

describe('verifyIrohPrebuild', () => {
  it.each(targets)(
    'accepts matching identity, hash and native architecture for %s',
    (slot, relative) => {
      const input = fixture(slot)
      expect(IROH_PREBUILD_FILES[slot]).toBe(relative)
      expect(verifyIrohPrebuild(input)).toBe(input.native)
    }
  )

  it.each([
    ['absent identity', (entry) => delete entry.iroh],
    ['stale SDK', (entry) => (entry.iroh.sdkVersion = '1.0.0')],
    ['stale source', (entry) => (entry.iroh.sourceRevision = 'old-source')],
    ['stale compiler', (entry) => (entry.iroh.compilerVersion = '1.90.0')],
    ['missing handshake patch', (entry) => delete entry.iroh.handshakePatchSha256],
    ['stale handshake patch', (entry) => (entry.iroh.handshakePatchSha256 = '0'.repeat(64))],
    ['stale recipe', (entry) => (entry.iroh.recipe = 'old-recipe')],
    ['missing source hash', (entry) => delete entry.iroh.sourceArchiveSha256],
    ['extra identity field', (entry) => (entry.iroh.untrusted = true)],
    [
      'changed compiler archive hash',
      (entry) => (entry.iroh.compilerArchives['x86_64-unknown-linux-gnu'].rustc = '0'.repeat(64))
    ]
  ])('rejects %s rather than trusting matching native bytes', (_label, change) => {
    const input = fixture()
    change(input.entry)
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*identity/i)
  })

  it.each(targets)('rejects stock pre-deadline identity for %s', (slot) => {
    const input = fixture(slot)
    delete input.entry.iroh.handshakePatchSha256
    input.entry.iroh.recipe = 'cargo-locked-release-strip-symbols-gcc-v1'
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*identity/i)
  })
  it('rejects an installed SDK version that differs from the build identity', () => {
    expect(() => verifyIrohPrebuild({ ...fixture(), version: '1.2.0' })).toThrow(/iroh.*version/i)
  })

  it('rejects a missing native file', () => {
    const input = fixture()
    rmSync(input.native)
    expect(() => verifyIrohPrebuild(input)).toThrow(/missing iroh native file/i)
  })

  it('requires a recorded native hash', () => {
    const input = fixture()
    delete input.entry.files[input.relative]
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*sha256/i)
  })

  it('rejects corrupt native bytes even when their ELF header is intact', () => {
    const input = fixture()
    const bytes = readFileSync(input.native)
    bytes[63] = 1
    writeFileSync(input.native, bytes)
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*sha256/i)
  })

  it.each([
    ['wrong machine', (bytes) => bytes.writeUInt16LE(183, 18)],
    ['not ELF', (bytes) => (bytes[0] = 0)],
    ['ELF32', (bytes) => (bytes[4] = 1)],
    ['big endian', (bytes) => (bytes[5] = 2)],
    ['truncated header', (bytes) => bytes.subarray(0, 20)]
  ])('rejects %s even with a matching hash', (_label, change) => {
    const input = fixture()
    const bytes = readFileSync(input.native)
    const changed = change(bytes)
    writeFileSync(input.native, Buffer.isBuffer(changed) ? changed : bytes)
    input.entry.files[input.relative] = createHash('sha256')
      .update(readFileSync(input.native))
      .digest('hex')
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*architecture/i)
  })

  it.each(targets)('rejects opposite-architecture bytes with a valid hash for %s', (slot) => {
    const input = fixture(slot)
    const bytes = nativeHeader(slot, slot.includes('-x64') ? 'arm64' : 'x64')
    writeFileSync(input.native, bytes)
    input.entry.files[input.relative] = createHash('sha256').update(bytes).digest('hex')
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*architecture/i)
  })

  it.each([
    ['darwin-arm64', 'non-Mach-O', (bytes) => bytes.writeUInt32LE(0, 0)],
    ['darwin-arm64', 'Mach-O executable', (bytes) => bytes.writeUInt32LE(2, 12)],
    ['darwin-arm64', 'truncated Mach-O', (bytes) => bytes.subarray(0, 16)],
    ['win32-x64', 'non-PE', (bytes) => bytes.write('NO', 0)],
    ['win32-arm64', 'invalid PE signature', (bytes) => bytes.write('NOPE', 64)],
    ['win32-x64', 'out-of-bounds PE offset', (bytes) => bytes.writeUInt32LE(0xffffffff, 0x3c)],
    ['win32-arm64', 'PE32', (bytes) => bytes.writeUInt16LE(0x10b, 88)],
    ['win32-x64', 'PE executable', (bytes) => bytes.writeUInt16LE(0, 86)],
    ['win32-arm64', 'truncated optional header', (bytes) => bytes.subarray(0, 90)]
  ])('rejects %s %s with a valid hash', (slot, _label, change) => {
    const input = fixture(slot)
    const bytes = readFileSync(input.native)
    const changed = change(bytes)
    writeFileSync(input.native, Buffer.isBuffer(changed) ? changed : bytes)
    input.entry.files[input.relative] = createHash('sha256')
      .update(readFileSync(input.native))
      .digest('hex')
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh.*architecture/i)
  })
  it('requires a regular native file, not a directory', () => {
    const input = fixture()
    rmSync(input.native)
    mkdirSync(input.native)
    expect(() => verifyIrohPrebuild(input)).toThrow(/iroh/i)
  })

  it.each(['darwin-x64', 'linux-x64-glibc217', 'linux-arm64-glibc217', 'win32-ia32'])(
    'refuses an explicitly requested unsupported slot %s',
    (slot) => {
      expect(() => verifyIrohPrebuild({ ...fixture(), slot })).toThrow(
        /unsupported iroh prebuild slot/i
      )
    }
  )
})

describe('fetchIrohBuildInput', () => {
  it('downloads pinned bytes, reuses a verified cache and rehashes a changed cache', async () => {
    const bytes = Buffer.from('official source or Rust archive fixture')
    const destination = join(temp(), 'cache', 'input.tar.xz')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await withBuildInput(bytes, async (url, requests) => {
      await fetchIrohBuildInput({ url, destination, sha256 })
      expect(readFileSync(destination)).toEqual(bytes)
      expect(requests).toHaveLength(1)
      await fetchIrohBuildInput({ url, destination, sha256 })
      expect(requests).toHaveLength(1)
      writeFileSync(destination, 'tampered cache')
      await fetchIrohBuildInput({ url, destination, sha256 })
      expect(requests).toHaveLength(2)
      expect(readFileSync(destination)).toEqual(bytes)
      expect(readdirSync(dirname(destination))).toEqual([basename(destination)])
    })
  })

  it.each([false, true])(
    'rejects untrusted downloaded bytes (existing cache: %s)',
    async (cached) => {
      const destination = join(temp(), 'input.tar.xz')
      if (cached) {
        writeFileSync(destination, 'untrusted cache')
      }
      const sha256 = createHash('sha256').update('trusted bytes').digest('hex')
      await withBuildInput(Buffer.from('wrong archive'), async (url, requests) => {
        await expect(fetchIrohBuildInput({ url, destination, sha256 })).rejects.toThrow(
          /iroh build input.*sha256 mismatch/i
        )
        expect(requests).toHaveLength(1)
        if (!cached) {
          expect(existsSync(destination)).toBe(false)
        }
        expect(
          readdirSync(dirname(destination)).filter((file) => file !== basename(destination))
        ).toEqual([])
      })
    }
  )
})

/** Presents one native host without changing the process environment or running a compiler. */
function nativeHost(slot) {
  const [platform, arch, libc] = slot.split('-')
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.spyOn(process, 'arch', 'get').mockReturnValue(arch)
  vi.spyOn(process.report, 'getReport').mockReturnValue({
    header: libc === 'glibc' ? { glibcVersionRuntime: '2.28' } : {}
  })
}

/** Emulates archives and Cargo at the process boundary; filesystem staging and verification stay real. */
function producerFixture(slot, { badChecksum = false, missingLock = false, output } = {}) {
  nativeHost(slot)
  const [, , target, library] = targets.find(([name]) => name === slot)
  const root = temp()
  const workDir = join(root, 'build')
  const sourceDir = join(workDir, `iroh-ffi-${IROH_BUILD_IDENTITY.sourceRevision}`)
  const source = join(workDir, 'target', target, 'release', library)
  mkdirSync(workDir)
  const untouched = join(workDir, 'existing-work')
  writeFileSync(untouched, 'keep until every archive verifies')
  const digests = new Map()
  let verified = 0
  const download = vi
    .spyOn(buildInputs, 'download')
    .mockImplementation(async (url, destination) => {
      const component = ['cargo', 'rustc', 'rust-std'].find((name) =>
        basename(url).startsWith(`${name}-`)
      )
      digests.set(
        destination,
        component
          ? IROH_BUILD_IDENTITY.compilerArchives[target][component]
          : IROH_BUILD_IDENTITY.sourceArchiveSha256
      )
      writeFileSync(destination, 'verified archive fixture')
    })
  vi.spyOn(buildInputs, 'sha256File').mockImplementation(async (path) => {
    verified += 1
    return badChecksum && basename(path).startsWith('rust-std-')
      ? '0'.repeat(64)
      : digests.get(path)
  })
  const patch = vi.spyOn(handshakePatch, 'applyIrohHandshakeDeadline').mockImplementation(() => {})
  vi.spyOn(windowsToolchain, 'initializeWindowsNativeToolchain').mockReturnValue({
    Path: 'native-compiler-path',
    VCINSTALLDIR: 'native-visual-studio',
    WindowsSDKVersion: '10.0.26100.0',
    VSCMD_ARG_TGT_ARCH: slot.split('-')[1]
  })
  vi.mocked(runProcessSync).mockImplementation(({ program, args }) => {
    expect(verified).toBe(4)
    if (args[0] === '-xzf') {
      mkdirSync(sourceDir, { recursive: true })
      if (!missingLock) {
        writeFileSync(join(sourceDir, 'Cargo.lock'), 'pinned lock fixture')
      }
    } else if (args[0] === '-xJf') {
      expect(patch).toHaveBeenCalledExactlyOnceWith(sourceDir)
      const name = basename(args[1], '.tar.xz')
      const component = ['cargo', 'rustc', 'rust-std'].find((item) => name.startsWith(`${item}-`))
      const payload = join(
        workDir,
        name,
        component === 'rust-std' ? `rust-std-${target}` : component
      )
      const child =
        component === 'rust-std'
          ? join('lib', 'rustlib', target, 'lib', 'std.rlib')
          : join('bin', `${component}.exe`)
      mkdirSync(dirname(join(payload, child)), { recursive: true })
      writeFileSync(join(payload, child), component)
      writeFileSync(join(payload, 'manifest.in'), 'installer bookkeeping')
    } else if (basename(program) === 'cargo' || basename(program) === 'cargo.exe') {
      expect(patch).toHaveBeenCalledExactlyOnceWith(sourceDir)
      mkdirSync(dirname(source), { recursive: true })
      writeFileSync(source, output ?? nativeHeader(slot))
    }
    return { code: 0 }
  })
  return { root, slot, workDir, sourceDir, source, target, untouched, download, patch }
}

describe('buildIrohPrebuild', () => {
  it.each(targets)(
    'produces verified patched native bytes for %s',
    async (slot, relative, target) => {
      const input = producerFixture(slot)
      const environment = { ...process.env }
      const result = await buildIrohPrebuild(input)
      expect(result).toEqual({ relative, source: input.source, identity: IROH_BUILD_IDENTITY })
      expect(result.identity.handshakePatchSha256).toBe(handshakePatch.IROH_HANDSHAKE_PATCH_SHA256)
      expect(process.env).toEqual(environment)
      expect(input.download.mock.calls.map(([url]) => url)).toEqual([
        `https://codeload.github.com/n0-computer/iroh-ffi/tar.gz/${IROH_BUILD_IDENTITY.sourceRevision}`,
        ...['cargo', 'rustc', 'rust-std'].map(
          (component) =>
            `https://static.rust-lang.org/dist/2025-11-10/${component}-1.91.1-${target}.tar.xz`
        )
      ])
      const calls = vi.mocked(runProcessSync).mock.calls.map(([call]) => call)
      const cargo = calls.find(({ args }) => args[0] === 'build')
      expect(cargo.cwd).toBe(input.workDir)
      expect(cargo.program).toBe(
        join(input.workDir, 'rust', 'bin', slot.startsWith('win32') ? 'cargo.exe' : 'cargo')
      )
      expect(cargo.args).toEqual([
        'build',
        '--locked',
        '--release',
        '--manifest-path',
        join(input.sourceDir, 'iroh-js', 'Cargo.toml'),
        '--package',
        'number0_iroh',
        '--target',
        target,
        '--target-dir',
        join(input.workDir, 'target'),
        '--config',
        'profile.release.strip="symbols"'
      ])
      const linker = slot.startsWith('win32')
        ? 'link.exe'
        : slot.startsWith('darwin')
          ? 'clang'
          : 'gcc'
      expect(cargo.env[`CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`]).toBe(
        linker
      )
      expect(cargo.env.CC).toBe(slot.startsWith('win32') ? 'cl.exe' : linker)
      expect(cargo.env.RUSTC).toBe(
        join(input.workDir, 'rust', 'bin', slot.startsWith('win32') ? 'rustc.exe' : 'rustc')
      )
      expect(cargo.env.CARGO_HOME).toBe(join(input.workDir, 'cargo-home'))
      expect(cargo.env.RUSTC_WRAPPER).toBe('')
      expect(cargo.env.RUSTC_WORKSPACE_WRAPPER).toBe('')
      const rustflags = slot.startsWith('win32')
        ? '-Ctarget-feature=+crt-static'
        : slot.endsWith('musl')
          ? '-Ctarget-feature=-crt-static'
          : ''
      expect(cargo.env.RUSTFLAGS).toBe(rustflags)
      expect(cargo.env.CARGO_ENCODED_RUSTFLAGS).toBe(rustflags)
      const installers = calls.filter(({ program }) => program === 'bash')
      if (slot.startsWith('win32')) {
        expect(installers).toHaveLength(0)
        expect(calls[0].program).toBe(
          join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        )
        expect(readFileSync(join(input.workDir, 'rust', 'bin', 'rustc.exe'), 'utf8')).toBe('rustc')
        expect(existsSync(join(input.workDir, 'rust', 'manifest.in'))).toBe(false)
        expect(Object.keys(cargo.env).filter((key) => key.toLowerCase() === 'path')).toEqual([
          'Path'
        ])
      } else {
        expect(installers).toHaveLength(3)
        for (const { args } of installers) {
          expect(args.slice(1)).toEqual([
            `--prefix=${join(input.workDir, 'rust')}`,
            '--disable-ldconfig'
          ])
        }
      }
      const slotDir = join(input.root, 'published')
      const native = join(slotDir, relative)
      mkdirSync(dirname(native), { recursive: true })
      const bytes = readFileSync(result.source)
      writeFileSync(native, bytes)
      expect(
        verifyIrohPrebuild({
          slotDir,
          slot,
          version: '1.1.0',
          entry: {
            iroh: result.identity,
            files: { [relative]: createHash('sha256').update(bytes).digest('hex') }
          }
        })
      ).toBe(native)
    }
  )

  it.each(targets)('rejects a non-native architecture before touching %s inputs', async (slot) => {
    nativeHost(slot)
    vi.spyOn(process, 'arch', 'get').mockReturnValue(slot.includes('-x64') ? 'arm64' : 'x64')
    const download = vi
      .spyOn(buildInputs, 'download')
      .mockRejectedValue(new Error('must not fetch'))
    const root = temp()
    await expect(buildIrohPrebuild({ root, slot, workDir: join(root, 'build') })).rejects.toThrow(
      /native.*host/i
    )
    expect(download).not.toHaveBeenCalled()
    expect(runProcessSync).not.toHaveBeenCalled()
    expect(readdirSync(root)).toEqual([])
  })

  it.each([
    ['linux-x64-glibc', 'linux-x64-musl'],
    ['linux-arm64-musl', 'linux-arm64-glibc'],
    ['darwin-arm64', 'linux-arm64-glibc'],
    ['win32-x64', 'linux-x64-glibc']
  ])('rejects slot %s on host %s before fetching', async (slot, host) => {
    nativeHost(host)
    const download = vi
      .spyOn(buildInputs, 'download')
      .mockRejectedValue(new Error('must not fetch'))
    const root = temp()
    await expect(buildIrohPrebuild({ root, slot, workDir: join(root, 'build') })).rejects.toThrow(
      /native.*host/i
    )
    expect(download).not.toHaveBeenCalled()
  })

  it.each(['darwin-x64', 'linux-x64-glibc217', 'linux-arm64-glibc217'])(
    'rejects unsupported producer slot %s',
    async (slot) => {
      await expect(buildIrohPrebuild({ root: temp(), slot, workDir: temp() })).rejects.toThrow(
        /unsupported.*slot/i
      )
      expect(runProcessSync).not.toHaveBeenCalled()
    }
  )

  it.each(['workspace root', 'outside workspace'])(
    'rejects workDir at %s without deletion',
    async (location) => {
      nativeHost('linux-x64-glibc')
      const root = temp()
      const workDir = location === 'workspace root' ? root : temp()
      const marker = join(workDir, 'keep')
      writeFileSync(marker, 'untouched')
      const download = vi
        .spyOn(buildInputs, 'download')
        .mockRejectedValue(new Error('must not fetch'))
      await expect(buildIrohPrebuild({ root, slot: 'linux-x64-glibc', workDir })).rejects.toThrow(
        /workDir.*inside/i
      )
      expect(readFileSync(marker, 'utf8')).toBe('untouched')
      expect(download).not.toHaveBeenCalled()
    }
  )

  it('verifies every archive before deleting work or executing any downloaded input', async () => {
    const input = producerFixture('linux-x64-glibc', { badChecksum: true })
    await expect(buildIrohPrebuild(input)).rejects.toThrow(/sha256 mismatch/i)
    expect(existsSync(input.untouched)).toBe(true)
    expect(input.patch).not.toHaveBeenCalled()
    expect(runProcessSync).not.toHaveBeenCalled()
  })

  it('requires the source lockfile before patching or installing Rust', async () => {
    const input = producerFixture('linux-x64-glibc', { missingLock: true })
    await expect(buildIrohPrebuild(input)).rejects.toThrow(/missing Cargo.lock/i)
    expect(input.patch).not.toHaveBeenCalled()
    expect(runProcessSync).toHaveBeenCalledTimes(1)
  })

  it('does not install or compile when the reviewed patch cannot be applied', async () => {
    const input = producerFixture('linux-x64-glibc')
    input.patch.mockImplementation(() => {
      throw new Error('patch rejected source')
    })
    await expect(buildIrohPrebuild(input)).rejects.toThrow('patch rejected source')
    expect(runProcessSync).toHaveBeenCalledTimes(1)
  })

  it.each(['missing SDK', 'wrong compiler architecture'])(
    'requires native Windows MSVC: %s',
    async (reason) => {
      const input = producerFixture('win32-arm64')
      vi.mocked(windowsToolchain.initializeWindowsNativeToolchain).mockReturnValue({
        VCINSTALLDIR: 'visual-studio',
        WindowsSDKVersion: reason === 'missing SDK' ? '' : '10.0.26100.0',
        VSCMD_ARG_TGT_ARCH: reason === 'missing SDK' ? 'arm64' : 'x64'
      })
      await expect(buildIrohPrebuild(input)).rejects.toThrow(/native Visual Studio.*Windows SDK/i)
      expect(vi.mocked(runProcessSync).mock.calls.some(([{ args }]) => args[0] === 'build')).toBe(
        false
      )
    }
  )

  it.each(targets)('refuses wrong-architecture compiler output for %s', async (slot) => {
    const input = producerFixture(slot, {
      output: nativeHeader(slot, slot.includes('-x64') ? 'arm64' : 'x64')
    })
    await expect(buildIrohPrebuild(input)).rejects.toThrow(/iroh.*architecture/i)
  })
})
