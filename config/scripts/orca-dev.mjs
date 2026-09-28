#!/usr/bin/env node

import { createRequire } from 'node:module'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { cliRuntimeFilename } from '../bundled-cli-runtime.cjs'
import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mjs'

const scriptPath = realpathSync(import.meta.filename)
const scriptDir = path.dirname(scriptPath)
const repoRoot = path.resolve(scriptDir, '..', '..')
const cliEntry =
  process.env.ORCA_DEV_CLI_ENTRY_PATH ?? path.join(repoRoot, 'out', 'cli', 'index.js')

if (!existsSync(cliEntry)) {
  console.error("orca-dev: CLI not built yet. Run 'pnpm run build:cli' first.")
  process.exit(1)
}

const runtimePath = path.join(
  repoRoot,
  'out',
  'cli-runtime',
  `${process.platform}-${process.arch}`,
  cliRuntimeFilename(process.platform)
)
if (!isRunnableFile(runtimePath)) {
  console.error('orca-dev: Bun runtime missing. Run pnpm run build:cli first.')
  process.exit(78)
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

const launcherPath = path.join(repoRoot, 'out', 'cli', 'cli-bun-launcher.js')
if (!existsSync(launcherPath)) {
  console.error('orca-dev: CLI launcher missing. Run pnpm run build:cli first.')
  process.exit(78)
}
const { launchBunCli } = createRequire(import.meta.url)(launcherPath)
launchBunCli(runtimePath, cliEntry, process.argv.slice(2))

function getDefaultDevUserDataPath() {
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'orca-dev')
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
      'orca-dev'
    )
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'),
    'orca-dev'
  )
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
