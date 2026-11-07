// Every supported SDK slot is built from the same reviewed source and incoming-handshake patch.
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { createRequire } from 'node:module'
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
  sep
} from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  download,
  sha256File
} from '../../node-runtime/archive-identity/update-node-runtime-pin.mjs'
import {
  applyIrohHandshakeDeadline,
  IROH_HANDSHAKE_PATCH_SHA256
} from './iroh-handshake-deadline.mjs'

const require = createRequire(import.meta.url)
const { ELF_MACHINE_BY_ARCH } = require('../../native-build/linux/verify-linux-glibc-floor.cjs')
const { PE_MACHINE } = require('../../native-build/windows/windows-pe-machine.cjs')

/** Existing native Node targets; unsupported desktop/compat slots never use stock npm bytes. */
export const IROH_PREBUILD_FILES = Object.freeze({
  'linux-x64-glibc': 'iroh/iroh.linux-x64-gnu.node',
  'linux-arm64-glibc': 'iroh/iroh.linux-arm64-gnu.node',
  'linux-x64-musl': 'iroh/iroh.linux-x64-musl.node',
  'linux-arm64-musl': 'iroh/iroh.linux-arm64-musl.node',
  'darwin-arm64': 'iroh/iroh.darwin-arm64.node',
  'win32-x64': 'iroh/iroh.win32-x64-msvc.node',
  'win32-arm64': 'iroh/iroh.win32-arm64-msvc.node'
})

/** Change the recipe identity whenever its source, compiler, inputs, or build command changes. */
export const IROH_BUILD_IDENTITY = Object.freeze({
  sdkVersion: '1.1.0',
  sourceRevision: '16221a5286fd201c00fab6e9a316285a05492b39',
  sourceArchiveSha256: 'aaeaabe52301fea4bf60646b1a5effd8be123d0a1a2c127f5faa919fb64ee881',
  handshakePatchSha256: IROH_HANDSHAKE_PATCH_SHA256,
  compilerVersion: '1.91.1',
  compilerArchiveDate: '2025-11-10',
  // Official xz_hash values: https://static.rust-lang.org/dist/channel-rust-1.91.1.toml
  compilerArchives: Object.freeze({
    'x86_64-unknown-linux-gnu': Object.freeze({
      cargo: '8d17d5a4734e684228adee4ea4a75da94eb7f71993804adf29f344709e65fe09',
      rustc: '4b4c596fc5268435c310a79c2e231a5a3567572c930ac0740ef9e147e83baf4e',
      'rust-std': '2023ed689529516d7bd5533738ca6d205b2561f8d51947dabeeb39dd51a024c9'
    }),
    'aarch64-unknown-linux-gnu': Object.freeze({
      cargo: '827692e153382eadc39b6f1262e20ed9671e1c0abf2fb14b5095816d2b295a15',
      rustc: 'b9040293bc84d8b48cb859dcd0e95955c13ea29e3e637c7556bf7f0c12972217',
      'rust-std': '6aed0726a0fe50cbd488f6c5dd7a053c17ff57b8b361d14bcd216ea9939fb531'
    }),
    'x86_64-unknown-linux-musl': Object.freeze({
      cargo: 'f7e433f236d6ee40d99905803400008d206070ddf934839e6999aca8301e2145',
      rustc: '644627a9accb83e5ee3c4607a4c9dc7ce241fe6f76cc4bc8354e2b186a145fb8',
      'rust-std': '4066d5dce6017dcd116c75972b3ec6c26fe5a1fa59f02a1da9e127d1f4a1aa7f'
    }),
    'aarch64-unknown-linux-musl': Object.freeze({
      cargo: '4ab2e726f61107c4f1f5f8c19125ec82c621af02745aaa750c6fe069cb6d0e03',
      rustc: 'e92ce38db596298e7ee24138b24bc3bf12d83d89824dea7f6a44ed3b51ad700d',
      'rust-std': '2a919a0e5df46e1bfe4b8be8fbc81cf48bf9813be34ff5f212a2a68f03eb517f'
    }),
    'aarch64-apple-darwin': Object.freeze({
      cargo: 'f6162fbbe0a514efcbd488cf78524fe5bfbc000b197922a8ff2b7f8440fa235a',
      rustc: '327c9017195b4ad0465ab6b1f1036377415cc6dc3612301af6ed9e3414ff53c8',
      'rust-std': 'edf0e5053da34759bdbc1abc47dab7d9882c8b4c68b5fdbeb103b6a5a0d23a58'
    }),
    'x86_64-pc-windows-msvc': Object.freeze({
      cargo: 'c4c92176d661c270a5f052bd934aa879846edcfe0fe2ca3fb0107c71a21a2f0c',
      rustc: 'e4a033c385c55f8c5271922dfc442f78fba41318148f96d45d9755baa074d0d9',
      'rust-std': '75404002509ff14fb1e87e4b5e8be4d1dacba8dde56348d176480d0741dbb1d9'
    }),
    'aarch64-pc-windows-msvc': Object.freeze({
      cargo: 'd11f2fc4941b7563415ea48b57820bc9e79c3e2fe09ae52bf854c28f7000e0fd',
      rustc: '47ec1c15a041264d94c2d4b12f9ef0bdb745127e09691e7af409c26f0259c668',
      'rust-std': '0e98b009f208417bbe0633608518ba9a80e17f7ff4bae66ff2cd36b9e26d7d14'
    })
  }),
  recipe: 'cargo-locked-release-strip-symbols-native-handshake-deadline-v2'
})

/** Rehash cached inputs and publish downloads only after their pinned checksum passes. */
export async function fetchIrohBuildInput({ url, destination, sha256 }) {
  if (existsSync(destination) && (await sha256File(destination)) === sha256) {
    return destination
  }
  mkdirSync(dirname(destination), { recursive: true })
  const partial = `${destination}.partial-${process.pid}`
  try {
    await download(url, partial)
    const actual = await sha256File(partial)
    if (actual !== sha256) {
      throw new Error(
        `[orcad-prebuilds] iroh build input sha256 mismatch for ${url}: ${actual}, expected ${sha256}`
      )
    }
    renameSync(partial, destination)
    return destination
  } finally {
    rmSync(partial, { force: true })
  }
}

/** Require a native 64-bit shared-library header, not merely a matching manifest hash. */
function assertIrohArchitecture(bytes, slot) {
  const [platform, arch] = slot.split('-')
  let valid = false
  if (platform === 'linux') {
    valid =
      bytes.length >= 64 &&
      bytes.readUInt32LE(0) === 0x464c457f &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(16) === 3 &&
      bytes.readUInt16LE(18) === ELF_MACHINE_BY_ARCH[arch]
  } else if (platform === 'darwin') {
    valid =
      bytes.length >= 32 &&
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === 0x0100000c &&
      bytes.readUInt32LE(12) === 6
  } else if (bytes.length >= 64 && bytes.toString('latin1', 0, 2) === 'MZ') {
    const pe = bytes.readUInt32LE(0x3c)
    valid =
      pe >= 64 &&
      pe <= bytes.length - 26 &&
      bytes.toString('latin1', pe, pe + 4) === 'PE\0\0' &&
      bytes.readUInt16LE(pe + 4) === PE_MACHINE[arch] &&
      bytes.readUInt16LE(pe + 20) >= 112 &&
      pe + 24 + bytes.readUInt16LE(pe + 20) <= bytes.length &&
      (bytes.readUInt16LE(pe + 22) & 0x2000) !== 0 &&
      bytes.readUInt16LE(pe + 24) === 0x20b
  }
  if (!valid) {
    throw new Error(
      `[orcad-prebuilds] ${slot}: iroh architecture must be native ${platform} ${arch} shared-library format`
    )
  }
}

/** Refuse absent, stale, corrupt, or wrong-architecture SDK bytes before a consumer copies them. */
export function verifyIrohPrebuild({ slotDir, slot, entry, version }) {
  const relative = Object.hasOwn(IROH_PREBUILD_FILES, slot) ? IROH_PREBUILD_FILES[slot] : null
  if (!relative) {
    throw new Error(`[orcad-prebuilds] unsupported iroh prebuild slot: ${slot}`)
  }
  if (!isDeepStrictEqual(entry?.iroh, IROH_BUILD_IDENTITY)) {
    throw new Error(`[orcad-prebuilds] ${slot}: stale or missing iroh build identity`)
  }
  if (version !== IROH_BUILD_IDENTITY.sdkVersion) {
    throw new Error(
      `[orcad-prebuilds] ${slot}: iroh SDK version ${version} does not match ${IROH_BUILD_IDENTITY.sdkVersion}`
    )
  }
  const source = join(slotDir, ...relative.split('/'))
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error(`[orcad-prebuilds] ${slot}/${relative}: missing iroh native file`)
  }
  const expected = entry.files?.[relative]
  const bytes = readFileSync(source)
  if (
    !/^[a-f0-9]{64}$/.test(expected ?? '') ||
    createHash('sha256').update(bytes).digest('hex') !== expected
  ) {
    throw new Error(
      `[orcad-prebuilds] ${slot}/${relative}: iroh sha256 does not match the manifest`
    )
  }
  assertIrohArchitecture(bytes, slot)
  return source
}

/** Build patched SDK bytes using only verified local Rust inputs and the native host compiler. */
export async function buildIrohPrebuild({ root, slot, workDir }) {
  if (!Object.hasOwn(IROH_PREBUILD_FILES, slot)) {
    throw new Error(`[orcad-prebuilds] unsupported iroh prebuild slot: ${slot}`)
  }
  const [platform, arch, libc] = slot.split('-')
  const hostLibc =
    process.platform === 'linux'
      ? process.report?.getReport()?.header?.glibcVersionRuntime
        ? 'glibc'
        : 'musl'
      : undefined
  if (process.platform !== platform || process.arch !== arch || hostLibc !== libc) {
    throw new Error(
      `[orcad-prebuilds] ${slot}: iroh must be built on its matching native platform, architecture and libc host`
    )
  }
  root = resolve(root)
  workDir = resolve(workDir)
  const workspacePath = relativePath(root, workDir)
  if (
    !workspacePath ||
    workspacePath === '..' ||
    workspacePath.startsWith(`..${sep}`) ||
    isAbsolute(workspacePath)
  ) {
    throw new Error('[orcad-prebuilds] iroh workDir must be inside the workspace')
  }
  const targetArch = arch === 'x64' ? 'x86_64' : 'aarch64'
  const target = `${targetArch}-${
    platform === 'linux'
      ? `unknown-linux-${libc === 'glibc' ? 'gnu' : 'musl'}`
      : platform === 'darwin'
        ? 'apple-darwin'
        : 'pc-windows-msvc'
  }`
  const cacheDir = join(root, 'out', 'iroh-build-cache')
  const identity = IROH_BUILD_IDENTITY
  const sourceArchive = await fetchIrohBuildInput({
    url: `https://codeload.github.com/n0-computer/iroh-ffi/tar.gz/${identity.sourceRevision}`,
    destination: join(cacheDir, `iroh-ffi-${identity.sourceRevision}.tar.gz`),
    sha256: identity.sourceArchiveSha256
  })
  const components = []
  for (const [component, sha256] of Object.entries(identity.compilerArchives[target])) {
    const name = `${component}-${identity.compilerVersion}-${target}`
    const archive = await fetchIrohBuildInput({
      url: `https://static.rust-lang.org/dist/${identity.compilerArchiveDate}/${name}.tar.xz`,
      destination: join(cacheDir, `${name}.tar.xz`),
      sha256
    })
    components.push({ component, name, archive })
  }
  // All source/compiler archives are verified before any archive is extracted or installer executed.
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const { runProcessSync } = await import('@orca/process-host')
  /** Propagate native build failures without a shell or process-wide environment changes. */
  function run(program, args, env = process.env) {
    const result = runProcessSync({
      program,
      args,
      cwd: workDir,
      env,
      stdio: 'inherit',
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(`[orcad-prebuilds] iroh ${program} failed (status ${result.code})`)
    }
  }
  const tar =
    platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  run(tar, ['-xzf', sourceArchive, '-C', workDir])
  const sourceDir = join(workDir, `iroh-ffi-${identity.sourceRevision}`)
  if (!existsSync(join(sourceDir, 'Cargo.lock'))) {
    throw new Error('[orcad-prebuilds] pinned iroh source is missing Cargo.lock')
  }
  applyIrohHandshakeDeadline(sourceDir)
  const prefix = join(workDir, 'rust')
  for (const { component, name, archive } of components) {
    run(tar, ['-xJf', archive, '-C', workDir])
    if (platform === 'win32') {
      // Official component payloads already have prefix-relative bin/lib paths; no shell or global installer.
      const payload = join(
        workDir,
        name,
        component === 'rust-std' ? `rust-std-${target}` : component
      )
      for (const child of readdirSync(payload)) {
        if (child !== 'manifest.in') {
          cpSync(join(payload, child), join(prefix, child), { recursive: true })
        }
      }
    } else {
      // The official installer defaults to /usr/local and ldconfig; disable both global effects.
      run('bash', [join(workDir, name, 'install.sh'), `--prefix=${prefix}`, '--disable-ldconfig'])
    }
  }
  let environment = process.env
  if (platform === 'win32') {
    const { initializeWindowsNativeToolchain, mergeWindowsCompilerEnvironment } =
      await import('../../native-build/windows/initialize-windows-native-toolchain.mjs')
    const compilerEnvironment = initializeWindowsNativeToolchain()
    if (compilerEnvironment) {
      environment = mergeWindowsCompilerEnvironment(environment, compilerEnvironment)
    }
    const value = (name) =>
      Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    if (
      !value('VCINSTALLDIR') ||
      !value('WindowsSDKVersion') ||
      ![arch, arch === 'x64' ? 'amd64' : 'arm64'].includes(
        value('VSCMD_ARG_TGT_ARCH')?.toLowerCase()
      )
    ) {
      throw new Error(
        `[orcad-prebuilds] ${slot}: native Visual Studio C++ compiler and Windows SDK environment is required`
      )
    }
  }
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const executableSuffix = platform === 'win32' ? '.exe' : ''
  const linker = platform === 'win32' ? 'link.exe' : platform === 'darwin' ? 'clang' : 'gcc'
  // Match upstream's Windows static CRT policy; musl needs its dynamic CRT to emit a Node cdylib.
  const rustflags =
    platform === 'win32'
      ? '-Ctarget-feature=+crt-static'
      : libc === 'musl'
        ? '-Ctarget-feature=-crt-static'
        : ''
  const env = {
    ...environment,
    [pathKey]: `${join(prefix, 'bin')}${delimiter}${environment[pathKey] ?? ''}`,
    CARGO_HOME: join(workDir, 'cargo-home'),
    RUSTC: join(prefix, 'bin', `rustc${executableSuffix}`),
    RUSTC_WRAPPER: '',
    RUSTC_WORKSPACE_WRAPPER: '',
    RUSTFLAGS: rustflags,
    CARGO_ENCODED_RUSTFLAGS: rustflags,
    CC: platform === 'win32' ? 'cl.exe' : linker,
    [`CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`]: linker
  }
  console.log(
    `[orcad-prebuilds] compiling iroh ${identity.sdkVersion} for ${slot} with Rust ${identity.compilerVersion} ...`
  )
  run(
    join(prefix, 'bin', `cargo${executableSuffix}`),
    [
      'build',
      '--locked',
      '--release',
      '--manifest-path',
      join(sourceDir, 'iroh-js', 'Cargo.toml'),
      '--package',
      'number0_iroh',
      '--target',
      target,
      '--target-dir',
      join(workDir, 'target'),
      '--config',
      'profile.release.strip="symbols"'
    ],
    env
  )
  const output =
    platform === 'win32'
      ? 'number0_iroh.dll'
      : `libnumber0_iroh.${platform === 'darwin' ? 'dylib' : 'so'}`
  const source = join(workDir, 'target', target, 'release', output)
  if (!existsSync(source)) {
    throw new Error(`[orcad-prebuilds] iroh build did not produce ${source}`)
  }
  assertIrohArchitecture(readFileSync(source), slot)
  return { relative: IROH_PREBUILD_FILES[slot], source, identity }
}
