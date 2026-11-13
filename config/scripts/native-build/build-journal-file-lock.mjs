import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  initializeWindowsNativeToolchain,
  mergeWindowsCompilerEnvironment
} from './windows/initialize-windows-native-toolchain.mjs'
import { runProcessSync } from '@orca/process-host'

export function buildJournalFileLock(output, arch = process.arch) {
  const root = resolve(import.meta.dirname, '../../..')
  mkdirSync(dirname(output), { recursive: true })
  const source = resolve(root, 'native/journal-file-lock/main.c')
  const windows = process.platform === 'win32'
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
  const result = runProcessSync({
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
