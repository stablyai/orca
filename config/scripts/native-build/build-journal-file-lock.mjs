import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { linuxNativeToolchainImage } from './linux/build-wayland-clipboard.mjs'
import glibcVerification from './linux/verify-linux-glibc-floor.cjs'
import { pathToFileURL } from 'node:url'
import {
  initializeWindowsNativeToolchain,
  mergeWindowsCompilerEnvironment
} from './windows/initialize-windows-native-toolchain.mjs'
import { runProcessSync } from '@orca/process-host'
import { MACOS_DEPLOYMENT_TARGET } from './posix/build-provider-exec.mjs'

// Reuse the desktop glibc-floor Docker image for desktop packaging; server slots follow
// build-provider-exec: floor/musl runners compile dynamically, newer Linux hosts link statically.
const LINUX_HARDENING = [
  '-fstack-protector-strong',
  '-D_FORTIFY_SOURCE=2',
  '-fPIE',
  '-pie',
  '-Wl,-z,relro,-z,now'
]
const LINUX_STATIC_HARDENING = [
  ...LINUX_HARDENING.filter((flag) => flag !== '-fPIE' && flag !== '-pie'),
  '-static'
]

// Keyed like the Wayland helper so CI can restore a desktop floor build and skip Docker.
export function desktopJournalFileLockFingerprint(root, arch) {
  const hash = createHash('sha256').update(arch)
  for (const file of [
    'native/journal-file-lock/main.c',
    'native/wayland-clipboard/Dockerfile',
    'config/scripts/native-build/build-journal-file-lock.mjs'
  ]) {
    hash.update('\0').update(readFileSync(join(root, file)))
  }
  return hash.digest('hex')
}

function reuseDesktopBuild(output, arch, stamp, fingerprint) {
  if (!existsSync(output) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== fingerprint) {
    return false
  }
  const outputDir = dirname(output)
  if (
    !glibcVerification.collectNativeBinaries(outputDir).includes(output) ||
    glibcVerification.findArchViolation(output, arch, outputDir)
  ) {
    return false
  }
  glibcVerification.verifyLinuxGlibcFloor(outputDir, { targetArch: arch })
  return true
}

export function buildJournalFileLock(
  output,
  arch = process.arch,
  { glibcFloor = 'server', run = runProcessSync } = {}
) {
  const root = resolve(import.meta.dirname, '../../..')
  mkdirSync(dirname(output), { recursive: true })
  const source = resolve(root, 'native/journal-file-lock/main.c')
  const windows = process.platform === 'win32'
  const linux = process.platform === 'linux'
  const desktop = glibcFloor === 'desktop'
  if (linux && !desktop && arch !== process.arch) {
    throw new Error('native lock needs a target-native Linux builder')
  }
  const glibcVersion = linux && process.report?.getReport()?.header?.glibcVersionRuntime
  const [major, minor] = typeof glibcVersion === 'string' ? glibcVersion.split('.').map(Number) : []
  const newerServerHost = glibcFloor === 'server' && (major > 2 || (major === 2 && minor > 28))
  if (linux && desktop) {
    const stamp = `${output}.sha256`
    const fingerprint = desktopJournalFileLockFingerprint(root, arch)
    if (reuseDesktopBuild(output, arch, stamp, fingerprint)) {
      return output
    }
    rmSync(stamp, { force: true })
    const docker = (args) => {
      const result = run({ program: 'docker', args, cwd: root, timeoutMs: 300000 })
      if (result.code !== 0) {
        throw new Error(`journal lock floor build failed: ${result.stderr}${result.stdout}`)
      }
    }
    const image = linuxNativeToolchainImage(root, docker)
    docker([
      'run',
      '--rm',
      '--user',
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      '-v',
      `${dirname(source)}:/source:ro`,
      '-v',
      `${resolve(dirname(output))}:/output`,
      image,
      'sh',
      '-ec',
      'case "$1" in x64) compiler=x86_64-linux-gnu-gcc;; arm64) compiler=aarch64-linux-gnu-gcc;; *) exit 2;; esac; "$compiler" -O2 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now /source/main.c -o "/output/$2"',
      'build',
      arch,
      basename(output)
    ])
    writeFileSync(stamp, fingerprint)
    return output
  }
  const args = windows
    ? [
        '/nologo',
        '/O2',
        '/W4',
        '/WX',
        '/DUNICODE',
        '/D_UNICODE',
        source,
        `/Fe:${output}`,
        `/Fo:${output}.obj`
      ]
    : [
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        ...(linux ? (newerServerHost ? LINUX_STATIC_HARDENING : LINUX_HARDENING) : []),
        ...(process.platform === 'darwin'
          ? [
              '-arch',
              arch === 'x64' ? 'x86_64' : arch,
              `-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`
            ]
          : []),
        source,
        '-o',
        output
      ]
  if (windows && arch !== process.arch) {
    throw new Error('native lock needs a target-native Windows builder')
  }
  const compilerEnvironment = windows ? initializeWindowsNativeToolchain() : undefined
  const result = run({
    program: windows ? 'cl.exe' : 'cc',
    args,
    cwd: root,
    env: compilerEnvironment
      ? mergeWindowsCompilerEnvironment(process.env, compilerEnvironment)
      : process.env,
    timeoutMs: 120000
  })
  if (result.code !== 0) {
    throw new Error(`journal lock build failed: ${result.stderr}${result.stdout}`)
  }
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--desktop-linux')) {
    // The path electron-builder's beforePack reads, so a prebuilt copy skips its Docker build.
    buildJournalFileLock(
      resolve('native/journal-file-lock/.build', process.arch, 'journal-file-lock'),
      process.arch,
      { glibcFloor: 'desktop' }
    )
  } else {
    buildJournalFileLock(
      resolve(
        'native/journal-file-lock/.build',
        process.platform === 'win32' ? 'journal-file-lock.exe' : 'journal-file-lock'
      )
    )
  }
}
