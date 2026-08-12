#!/usr/bin/env node
import { accessSync, constants, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

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

// Why: under a Git Bash setup runner, Orca exports ORCA_WORKTREE_PATH in MSYS form (/c/...), which
// cmd.exe cannot resolve. This is the migration pattern for any setup script feeding a native exe.
function posixShellPathToNativeWindowsPath(value) {
  const driveMatch = value.match(/^\/([A-Za-z])\/(.*)$/)
  if (driveMatch) {
    return `${driveMatch[1].toUpperCase()}:\\${driveMatch[2].replace(/\//g, '\\')}`
  }
  return value
}

function spawnOptionalSetup(spawn, setupPath, worktreePath, platform, env) {
  if (platform === 'win32') {
    const nativeWorktreePath = posixShellPathToNativeWindowsPath(worktreePath)
    spawn(
      env.ComSpec || 'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        `call ${quoteWindowsArg(setupPath)} ${quoteWindowsArg(nativeWorktreePath)}`
      ],
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

if (process.argv[1] && resolve(import.meta.filename) === resolve(process.argv[1])) {
  process.exit(runInternalDevSetup())
}
