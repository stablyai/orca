import { mkdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { linuxNativeToolchainImage } from './linux/build-wayland-clipboard.mjs'
import { pathToFileURL } from 'node:url'
import {
  initializeWindowsNativeToolchain,
  mergeWindowsCompilerEnvironment
} from './windows/initialize-windows-native-toolchain.mjs'
import { runProcessSync } from '@orca/process-host'

export function buildJournalFileLock(
  output,
  arch = process.arch,
  { glibcFloor = false, run = runProcessSync } = {}
) {
  const root = resolve(import.meta.dirname, '../../..')
  mkdirSync(dirname(output), { recursive: true })
  const source = resolve(root, 'native/journal-file-lock/main.c')
  const windows = process.platform === 'win32'
  if (process.platform === 'linux' && glibcFloor) {
    const docker = (args) => {
      const result = run({ program: 'docker', args, cwd: root, timeoutMs: 120000 })
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
  if (process.platform === 'linux' && arch !== process.arch) {
    throw new Error('native lock needs a target-native Linux builder')
  }
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
