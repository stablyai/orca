#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  // Why: electron-builder's win extraResources ship both the orca launcher and
  // the agent-teams tmux shim; building only the default target leaves tmux.exe
  // missing and breaks packaging.
  for (const target of ['orca', 'tmux']) {
    runNodeScript('config/scripts/build-windows-cli-launcher.mjs', '--target', target)
  }
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
  process.exit(0)
}

runPnpmScript('build:computer-macos')
runPnpmScript('build:notification-status-macos')
process.exit(0)

function runPnpmScript(scriptName) {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath
    ? process.execPath
    : process.platform === 'win32'
      ? 'pnpm.cmd'
      : 'pnpm'
  const args = npmExecPath ? [npmExecPath, 'run', scriptName] : ['run', scriptName]
  const result = spawnSync(command, args, { stdio: 'inherit' })

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1)
  }
}

function runNodeScript(scriptPath, ...args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' })
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1)
  }
}
