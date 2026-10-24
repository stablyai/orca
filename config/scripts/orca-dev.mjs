#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mjs'
import {
  getDevProfileBaseDir,
  isPrimaryWorktreePath,
  resolveAndClaimDevUserDataProfile
} from './dev-user-data-profile.mjs'

const scriptPath = realpathSync(import.meta.filename)
const scriptDir = path.dirname(scriptPath)
const repoRoot = path.resolve(scriptDir, '..', '..')
const cliEntry =
  process.env.ORCA_DEV_CLI_ENTRY_PATH ?? path.join(repoRoot, 'out', 'cli', 'index.js')

if (!existsSync(cliEntry)) {
  console.error("orca-dev: CLI not built yet. Run 'pnpm run build:cli' first.")
  process.exit(1)
}

process.env.ORCA_USER_DATA_PATH = process.env.ORCA_DEV_USER_DATA_PATH ?? getDefaultDevUserDataPath()
// Why: custom dev profiles do not necessarily contain "orca-dev" in their path; carry explicit provenance into the CLI.
process.env.ORCA_DEV_CLI_INVOCATION = '1'

const electronExecutable = getElectronExecutable()
if (!process.env.ORCA_APP_EXECUTABLE && isRunnableFile(electronExecutable)) {
  process.env.ORCA_APP_EXECUTABLE = electronExecutable
  process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT = '1'
}

// Why: headless `orca-dev serve` skips the Electron dev runner that normally installs terminal CLI shims.
prepareDevCliTerminalWrappers({
  repoRoot,
  userDataPath: process.env.ORCA_USER_DATA_PATH,
  electronExecutable: process.env.ORCA_APP_EXECUTABLE ?? electronExecutable
})

const result = spawnSync(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
})

if (result.signal) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? (result.error ? 1 : 0))

// Why the same resolution as the dev runner: `orca-dev status` run from a worktree must address that
// worktree's instance, not whichever instance last claimed the shared profile.
function getDefaultDevUserDataPath() {
  return resolveAndClaimDevUserDataProfile({
    repoRoot,
    baseDir: getDevProfileBaseDir(),
    isPrimaryWorktree: isPrimaryWorktreePath(
      readGitValue(['rev-parse', '--git-dir']),
      readGitValue(['rev-parse', '--git-common-dir']),
      repoRoot
    ),
    worktreeName: path.basename(repoRoot)
  }).path
}

function readGitValue(args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return result.status === 0 ? result.stdout.trim() || null : null
}

function getElectronExecutable() {
  if (process.platform === 'win32') {
    return path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  return path.join(repoRoot, 'node_modules', '.bin', 'electron')
}

function isRunnableFile(candidate) {
  try {
    const stats = statSync(candidate)
    if (!stats.isFile()) {
      return false
    }
    if (process.platform === 'win32') {
      return true
    }
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}
