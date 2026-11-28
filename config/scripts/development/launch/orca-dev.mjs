#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mjs'
import { resolveDevCliUserDataPath } from '../instance-isolation/dev-instance-isolation.mjs'

const scriptPath = realpathSync(import.meta.filename)
const scriptDir = path.dirname(scriptPath)
const repoRoot = path.resolve(scriptDir, '..', '..', '..', '..')
const cliEntry =
  process.env.ORCA_DEV_CLI_ENTRY_PATH ?? path.join(repoRoot, 'out', 'cli', 'index.js')

handOffToSessionCli()

if (!existsSync(cliEntry)) {
  console.error("orca-dev: CLI not built yet. Run 'pnpm run build:cli' first.")
  process.exit(1)
}

// Why: target the profile this checkout's `pnpm dev` uses (per-worktree in linked worktrees).
process.env.ORCA_USER_DATA_PATH = resolveDevCliUserDataPath({ repoRoot })
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

// A login shell can put this launcher ahead of the session's own CLI of the same name on PATH; run
// the one the session names. Runs by path or with a dev profile/entry stay here: handing those to a
// release session's CLI writes to the real app. ORCA_CLI_HANDOFF marks the hop so the named CLI
// never hands back. Windows shells keep the session's directory first, and a .cmd target would
// need cmd.exe.
function handOffToSessionCli() {
  const sessionCli = process.env.ORCA_CLI_COMMAND
  const invokedAs = path.basename(process.argv[1] ?? '')
  const handOff =
    process.platform !== 'win32' &&
    sessionCli &&
    path.isAbsolute(sessionCli) &&
    process.env.ORCA_CLI_HANDOFF !== sessionCli &&
    invokedAs === path.basename(sessionCli) &&
    !process.env.ORCA_DEV_USER_DATA_PATH &&
    !process.env.ORCA_DEV_PROFILE &&
    !process.env.ORCA_DEV_CLI_ENTRY_PATH &&
    isRunnableFile(sessionCli) &&
    realpathSync(sessionCli) !== scriptPath
  delete process.env.ORCA_CLI_HANDOFF
  if (!handOff) {
    return
  }
  console.error(`${invokedAs}: running this session's CLI, ${sessionCli}`)
  const result = spawnSync(sessionCli, process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, ORCA_CLI_HANDOFF: sessionCli }
  })
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  process.exit(result.status ?? (result.error ? 1 : 0))
}
