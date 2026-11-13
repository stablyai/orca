import { mkdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { linuxNativeToolchainImage } from './linux/build-wayland-clipboard.mjs'
import { pathToFileURL } from 'node:url'
import {
  initializeWindowsNativeToolchain,
  mergeWindowsCompilerEnvironment
} from './windows/initialize-windows-native-toolchain.mjs'
import { runProcessSync } from '@orca/process-host'

// Reuse the glibc 2.28 slot images from node-server-tests.yml.
const SERVER_TOOLCHAIN_IMAGES = {
  x64: 'quay.io/pypa/manylinux_2_28_x86_64@sha256:407f771c51a2c3e83ebe5a7970b4289ead3a6db21d9b9c089168775cad11d328',
  arm64:
    'quay.io/pypa/manylinux_2_28_aarch64@sha256:c22ffd129ac99a8a42d1f2c2f4e88a9089288dd9ee987a7092da1c7dc48f27a9'
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
  const serverToolchain = glibcFloor === 'server' && (major > 2 || (major === 2 && minor > 28))
  if (linux && (desktop || serverToolchain)) {
    const docker = (args) => {
      const result = run({ program: 'docker', args, cwd: root, timeoutMs: 300000 })
      if (result.code !== 0) {
        throw new Error(`journal lock floor build failed: ${result.stderr}${result.stdout}`)
      }
    }
    const image = desktop ? linuxNativeToolchainImage(root, docker) : SERVER_TOOLCHAIN_IMAGES[arch]
    if (!image) {
      throw new Error(`Unsupported journal lock architecture: ${arch}`)
    }
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
      `${desktop ? 'case "$1" in x64) compiler=x86_64-linux-gnu-gcc;; arm64) compiler=aarch64-linux-gnu-gcc;; *) exit 2;; esac;' : 'compiler=gcc;'} "$compiler" -O2 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now /source/main.c -o "/output/$2"`,
      'build',
      arch,
      basename(output)
    ])
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
        ...(process.platform === 'darwin' ? ['-arch', arch === 'x64' ? 'x86_64' : arch] : []),
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
  buildJournalFileLock(
    resolve(
      'native/journal-file-lock/.build',
      process.platform === 'win32' ? 'journal-file-lock.exe' : 'journal-file-lock'
    )
  )
}
