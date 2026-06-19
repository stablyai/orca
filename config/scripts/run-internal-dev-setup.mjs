#!/usr/bin/env node
import { accessSync, constants, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function isExecutable(filePath, platform, access = accessSync) {
  if (platform === 'win32') {
    return true
  }

  try {
    access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function quoteWindowsArg(value) {
  return `"${value.replace(/"/g, '""')}"`
}

function spawnOptionalSetup(spawn, setupPath, worktreePath, platform, env) {
  if (platform === 'win32') {
    spawn(
      env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `call ${quoteWindowsArg(setupPath)} ${quoteWindowsArg(worktreePath)}`],
      {
        stdio: 'inherit',
        windowsVerbatimArguments: true
      }
    )
    return
  }

  spawn(setupPath, [worktreePath], {
    stdio: 'inherit'
  })
}

export function runInternalDevSetup({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  exists = existsSync,
  access = accessSync,
  spawn = spawnSync
} = {}) {
  const setupPath = env.ORCA_INTERNAL_DEV_SETUP?.trim()
  if (!setupPath || !exists(setupPath) || !isExecutable(setupPath, platform, access)) {
    return 0
  }

  // Why: this hook is an optional local accelerator; failures should not block
  // creating a worktree or running the normal dependency install.
  spawnOptionalSetup(spawn, setupPath, env.ORCA_WORKTREE_PATH || cwd, platform, env)

  return 0
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exit(runInternalDevSetup())
}
