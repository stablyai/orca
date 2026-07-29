import { cp, mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function readAppDirArg(argv) {
  const explicit = argv.find((arg) => arg.startsWith('--app-dir='))
  if (explicit) {
    return explicit.slice('--app-dir='.length)
  }
  if (process.platform === 'darwin') {
    return 'dist/mac-arm64/Orca.app'
  }
  if (process.platform === 'win32') {
    return 'dist/win-unpacked'
  }
  return 'dist/linux-unpacked'
}

function getPackagedCliPath(appDir) {
  if (process.platform === 'darwin' || appDir.endsWith('.app')) {
    return join(appDir, 'Contents', 'Resources', 'bin', 'orca')
  }
  if (process.platform === 'win32') {
    return join(appDir, 'resources', 'bin', 'orca.exe')
  }
  return join(appDir, 'resources', 'bin', 'orca-ide')
}

const appDir = resolve(readAppDirArg(process.argv.slice(2)))
const tempRoot = await mkdtemp(join(tmpdir(), 'orca-packaged-cli-smoke-'))
const copiedAppDir = join(tempRoot, basename(appDir))

try {
  await cp(appDir, copiedAppDir, { recursive: true, verbatimSymlinks: true })
  const cliPath = getPackagedCliPath(copiedAppDir)
  await execFileAsync(cliPath, ['--help'], {
    env: { ...process.env, NODE_PATH: '' }
  })
  console.log(`[packaged-cli-smoke] ${cliPath} --help succeeded outside the repo`)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
