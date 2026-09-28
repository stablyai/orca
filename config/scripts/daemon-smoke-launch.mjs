import { bunOwnedRuntimeArgs } from '../../src/shared/bun-owned-runtime-args.ts'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cliRuntimeFilename, verifyCliRuntimeDirectory } from '../bundled-cli-runtime.cjs'

export function daemonSmokeEntry(projectDir) {
  return join(projectDir, 'out', 'terminal-daemon', 'daemon-entry.js')
}

export function daemonSmokeLaunchOptions(projectDir, userDataDir, env = process.env) {
  const runtimeDir = join(projectDir, 'out', 'cli-runtime', `${process.platform}-${process.arch}`)
  verifyCliRuntimeDirectory(runtimeDir, process.platform, process.arch)
  const entryPath = daemonSmokeEntry(projectDir)
  if (!existsSync(entryPath)) {
    throw new Error(`Missing ${entryPath}; run pnpm build:terminal-daemon first`)
  }
  const daemonEnv = { ...env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_USER_DATA_PATH: userDataDir }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_PATH',
    'BUN_OPTIONS',
    'BUN_INSPECT',
    'BUN_INSPECT_BRK',
    'BUN_INSPECT_WAIT',
    'BUN_CONPTY_LIBRARY'
  ]) {
    delete daemonEnv[key]
  }
  if (process.platform === 'win32') {
    daemonEnv.BUN_CONPTY_LIBRARY = join(runtimeDir, 'conpty', 'conpty.dll')
  }
  return {
    program: join(runtimeDir, cliRuntimeFilename(process.platform)),
    entryPath,
    options: {
      cwd: userDataDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: daemonEnv
    }
  }
}

export function spawnDaemonSmoke(projectDir, userDataDir, args) {
  const launch = daemonSmokeLaunchOptions(projectDir, userDataDir)
  return spawn(
    launch.program,
    [...bunOwnedRuntimeArgs(), launch.entryPath, ...args],
    launch.options
  )
}
