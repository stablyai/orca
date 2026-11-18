#!/usr/bin/env node
// Builds native/provider-exec for one target into native/provider-exec/.build/<target>/.
// Desktop Linux targets compile in the glibc-floor Docker toolchain; server slots (linux-*-glibc,
// -glibc217, -musl) use the slot runner's own compiler, which build-orcad-prebuilds gates.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import glibcVerification from '../linux/verify-linux-glibc-floor.cjs'
import { linuxNativeToolchainImage } from '../linux/build-wayland-clipboard.mjs'

const PROVIDER_EXEC_EXECUTABLE = 'orca-provider-exec'
// Equals the desktop's minimumSystemVersion; the pinned server Node needs a newer macOS anyway.
const MACOS_DEPLOYMENT_TARGET = '13.4'
const SOURCE = 'native/provider-exec/provider-exec.c'
const WARNINGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror']
const LINUX_HARDENING = [
  '-fstack-protector-strong',
  '-D_FORTIFY_SOURCE=2',
  '-fPIE',
  '-pie',
  '-Wl,-z,relro,-z,now'
]
const MACH_O_CPU_TYPES = { x64: 0x01000007, arm64: 0x0100000c }
const HOST_GLIBC_RUNTIME =
  process.platform === 'linux'
    ? (process.report?.getReport()?.header?.glibcVersionRuntime ?? null)
    : null
const SLOT_GLIBC_FLOORS = {
  glibc: glibcVerification.SERVER_SLOT_GLIBC_FLOOR,
  glibc217: glibcVerification.COMPAT_SLOT_GLIBC_FLOOR
}

/** `darwin-<arch>`, desktop `linux-<arch>`, or a server slot `linux-<arch>-<libc>`. */
function parseProviderExecTarget(target) {
  const match = /^(darwin|linux)-(x64|arm64)(?:-(glibc|glibc217|musl))?$/.exec(target ?? '')
  if (!match || (match[1] === 'darwin' && match[3])) {
    throw new Error(`Unsupported provider exec target: ${target}`)
  }
  return { platform: match[1], arch: match[2], slotLibc: match[3] ?? null }
}

/** Desktop Linux uses Docker for its glibc floor; `hostCompiler` is for dev and server slots. */
function toolchainFor({ platform, slotLibc }, hostCompiler) {
  if (platform === 'darwin') {
    return 'xcrun-clang'
  }
  return slotLibc || hostCompiler ? 'host' : 'docker'
}

function providerExecFingerprint(root, target, toolchain) {
  const hash = createHash('sha256').update(
    `${target}\0${toolchain}\0${process.env.CC ?? ''}\0${HOST_GLIBC_RUNTIME ?? ''}`
  )
  const inputs = [SOURCE, 'config/scripts/native-build/posix/build-provider-exec.mjs']
  if (toolchain === 'docker') {
    inputs.push('native/wayland-clipboard/Dockerfile')
  }
  for (const file of inputs) {
    hash.update('\0').update(readFileSync(join(root, file)))
  }
  return hash.digest('hex')
}

// A host newer than the slot floor would pin crt1's __libc_start_main@GLIBC_2.34; release slots
// build on their floor image and stay dynamic, while ad hoc lanes on newer runners link statically.
function hostLinkFlags({ slotLibc }) {
  const floor = SLOT_GLIBC_FLOORS[slotLibc]?.families.find((family) => family.prefix === 'GLIBC_')
  if (
    !floor ||
    !HOST_GLIBC_RUNTIME ||
    glibcVerification.compareGlibcVersions(
      glibcVerification.parseGlibcVersion(HOST_GLIBC_RUNTIME),
      floor.floor
    ) <= 0
  ) {
    return LINUX_HARDENING
  }
  return [...LINUX_HARDENING.filter((flag) => flag !== '-fPIE' && flag !== '-pie'), '-static']
}

function readMachOCpuType(path) {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(8)
    if (readSync(fd, header, 0, 8, 0) !== 8 || header.readUInt32LE(0) !== 0xfeedfacf) {
      return null
    }
    return header.readUInt32LE(4)
  } finally {
    closeSync(fd)
  }
}

function verifyOutput(output, { platform, arch }, outputDir, toolchain) {
  if (platform === 'darwin') {
    if (readMachOCpuType(output) !== MACH_O_CPU_TYPES[arch]) {
      throw new Error(`${output} is not a thin ${arch} Mach-O executable`)
    }
    return
  }
  if (!glibcVerification.collectNativeBinaries(outputDir).includes(output)) {
    throw new Error(`${output} is not an ELF executable`)
  }
  const violation = glibcVerification.findArchViolation(output, arch, outputDir)
  if (violation) {
    throw new Error(`${output} is ${violation.actual}, expected ${arch}`)
  }
  // Server slots are gated at their own floor when build-orcad-prebuilds stores them; a dev
  // host build never ships, because packaging's Docker fingerprint differs.
  if (toolchain === 'docker') {
    glibcVerification.verifyLinuxGlibcFloor(outputDir, { targetArch: arch })
  }
}

export function buildProviderExec({
  target,
  hostCompiler = false,
  root = resolve(import.meta.dirname, '../../../..'),
  run = spawnSync
}) {
  const parsed = parseProviderExecTarget(target)
  const toolchain = toolchainFor(parsed, hostCompiler)
  if (toolchain === 'host' && parsed.arch !== process.arch) {
    throw new Error(`The host compiler cannot build ${target} on ${process.arch}`)
  }
  const nativeDir = join(root, 'native', 'provider-exec')
  const outputDir = join(nativeDir, '.build', target)
  const output = join(outputDir, PROVIDER_EXEC_EXECUTABLE)
  const fingerprint = providerExecFingerprint(root, target, toolchain)
  const stamp = `${output}.sha256`
  if (existsSync(output) && existsSync(stamp) && readFileSync(stamp, 'utf8') === fingerprint) {
    verifyOutput(output, parsed, outputDir, toolchain)
    chmodSync(output, 0o755)
    return output
  }
  mkdirSync(outputDir, { recursive: true })
  rmSync(stamp, { force: true })
  rmSync(output, { force: true })
  function invoke(command, args) {
    const result = run(command, args, { stdio: 'inherit', cwd: root })
    if (result.error) {
      throw new Error(`Unable to run ${command} to build the provider exec helper.`, {
        cause: result.error
      })
    }
    if (result.status !== 0) {
      throw new Error(`Provider exec helper ${command} failed; see the build output above.`)
    }
  }
  const source = join(root, SOURCE)
  if (toolchain === 'xcrun-clang') {
    invoke('xcrun', [
      'clang',
      '-arch',
      parsed.arch === 'x64' ? 'x86_64' : 'arm64',
      `-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`,
      ...WARNINGS,
      '-fstack-protector-strong',
      source,
      '-o',
      output
    ])
  } else if (toolchain === 'host') {
    invoke(process.env.CC || 'cc', [...WARNINGS, ...hostLinkFlags(parsed), source, '-o', output])
  } else {
    const docker = (args) => invoke('docker', args)
    const image = linuxNativeToolchainImage(root, docker)
    // Compile against the desktop glibc floor, including when packaging another architecture.
    docker([
      'run',
      '--rm',
      '--user',
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      '-v',
      `${nativeDir}:/source:ro`,
      '-v',
      `${outputDir}:/output`,
      image,
      'sh',
      '-ec',
      `case "$1" in x64) compiler=x86_64-linux-gnu-gcc;; arm64) compiler=aarch64-linux-gnu-gcc;; esac; "$compiler" ${[...WARNINGS, ...LINUX_HARDENING].join(' ')} /source/provider-exec.c -o /output/${PROVIDER_EXEC_EXECUTABLE}`,
      'build',
      parsed.arch
    ])
  }
  chmodSync(output, 0o755)
  verifyOutput(output, parsed, outputDir, toolchain)
  writeFileSync(stamp, fingerprint)
  return output
}

/** Unpackaged main resolves native/provider-exec/.build/<platform>-<arch>; any host compiler will do. */
export function buildHostProviderExec() {
  return buildProviderExec({ target: `${process.platform}-${process.arch}`, hostCompiler: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const targetIndex = argv.indexOf('--target')
  // Defaults to the desktop target this host runs, e.g. darwin-arm64 or linux-x64.
  const targets =
    targetIndex === -1 ? [`${process.platform}-${process.arch}`] : argv[targetIndex + 1].split(',')
  for (const target of targets) {
    buildProviderExec({ target, hostCompiler: argv.includes('--host-compiler') })
  }
}
