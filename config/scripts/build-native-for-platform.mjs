#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export function resolvePnpmInvocation(scriptName, npmExecPath, platform) {
  // npm_execpath is only runnable by node when it is a JS entrypoint. pnpm's
  // standalone build points it at a platform binary, so fall back to PATH.
  const runnableByNode = Boolean(npmExecPath) && /\.[cm]?js$/.test(npmExecPath)
  if (runnableByNode) {
    return { command: process.execPath, args: [npmExecPath, 'run', scriptName] }
  }
  return {
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: ['run', scriptName]
  }
}

function runPnpmScript(scriptName) {
  const { command, args } = resolvePnpmInvocation(
    scriptName,
    process.env.npm_execpath,
    process.platform
  )
  const result = spawnSync(command, args, { stdio: 'inherit' })

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

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.platform === 'win32') {
    runNodeScript('config/scripts/build-windows-cli-launcher.mjs')
    process.exit(0)
  }

  if (process.platform !== 'darwin') {
    console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
    process.exit(0)
  }

  runPnpmScript('build:computer-macos')
  runPnpmScript('build:keyboard-layout-macos')
  runPnpmScript('build:notification-status-macos')
  process.exit(0)
}
