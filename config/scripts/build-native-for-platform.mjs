#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

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

  return { command: needsShell ? `"${command}"` : command, args, shell: needsShell }
}

function runPnpmScript(scriptName) {
  const { command, args, shell } = resolvePnpmInvocation(scriptName, process.env.npm_execpath)
  const result = spawnSync(command, args, { stdio: 'inherit', shell })

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1)
  }
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' })
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform === 'win32') {
    runNodeScript('config/scripts/build-windows-cli-launcher.mjs')
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
