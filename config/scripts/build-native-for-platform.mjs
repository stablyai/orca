#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

const JS_ENTRY_PATTERN = /\.[cm]?js$/i
const WINDOWS_SHELL_ENTRY_PATTERN = /\.(?:cmd|bat)$/i

// Why: @pnpm/exe ships npm_execpath as a native binary that Node cannot parse as JS.
export function resolvePnpmInvocation(scriptName, npmExecPath, platform = process.platform) {
  const runArgs = ['run', scriptName]

  if (!npmExecPath) {
    return withWindowsShell(platform === 'win32' ? 'pnpm.cmd' : 'pnpm', runArgs, platform)
  }
  if (JS_ENTRY_PATTERN.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...runArgs], shell: false }
  }
  return withWindowsShell(npmExecPath, runArgs, platform)
}

// Why: unreachable today (the entry path exits on win32 before runPnpmScript); kept so a
// future Windows caller cannot reintroduce the CVE-2024-27980 .cmd/.bat spawn failure.
function withWindowsShell(command, args, platform) {
  const needsShell = platform === 'win32' && WINDOWS_SHELL_ENTRY_PATTERN.test(command)

  return {
    command: needsShell ? `"${command.replaceAll('"', '""')}"` : command,
    args,
    shell: needsShell
  }
}

// Why: argv[1] keeps the symlinked path that import.meta.filename resolves away, so comparing
// them raw would skip the whole build in silence behind a symlinked checkout.
export function isEntryPoint(entryPath, moduleFilename) {
  if (!entryPath) {
    return false
  }
  try {
    return realpathSync(entryPath) === realpathSync(moduleFilename)
  } catch {
    // Why: a path that cannot be resolved is not this module.
    return false
  }
}

function runOrExit(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  // Why: a spawn that never starts (missing pnpm, non-executable npm_execpath) reports its
  // cause only here, and exiting on status alone drops it.
  if (result.error) {
    console.error(`[native-build] could not run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function runPnpmScript(scriptName) {
  const { command, args, shell } = resolvePnpmInvocation(scriptName, process.env.npm_execpath)
  runOrExit(command, args, { shell })
}

if (isEntryPoint(process.argv[1], import.meta.filename)) {
  if (process.platform === 'win32') {
    runOrExit(process.execPath, ['config/scripts/build-windows-cli-launcher.mjs'])
    process.exit(0)
  }

  if (process.platform !== 'darwin') {
    console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
    process.exit(0)
  }

  runPnpmScript('build:computer-macos')
  runPnpmScript('build:notification-status-macos')
  process.exit(0)
}
