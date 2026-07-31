import { cp, mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

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
  const env = { ...process.env, NODE_PATH: '' }
  delete env.ORCA_CLI_CWD
  const run = (args) =>
    execFileAsync(cliPath, args, {
      env,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000
    })

  await run(['--help'])
  const list = JSON.parse((await run(['skills', 'list', '--json'])).stdout)
  assert(list.topics.some((topic) => topic.name === 'orca-cli'))
  assert.match((await run(['skills', 'get', 'orca-cli'])).stdout, /name: orca-cli/)
  assert.match((await run(['skills', 'get', 'computer-use'])).stdout, /name: computer-use/)
  const install = JSON.parse(
    (
      await run([
        'skills',
        'install',
        '--skill',
        'orca-cli',
        '--agent',
        'codex',
        '--dry-run',
        '--json'
      ])
    ).stdout
  )
  const update = JSON.parse(
    (await run(['skills', 'update', '--skill', 'orca-cli', '--dry-run', '--json'])).stdout
  )
  assert.equal(install.executed, false)
  assert.equal(update.executed, false)
  console.log(`[packaged-cli-smoke] help and skills commands passed via ${cliPath}`)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
