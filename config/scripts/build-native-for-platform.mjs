#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
  process.exit(0)
}

runPnpmScript('build:computer-macos')

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
  process.exit(result.status ?? (result.error ? 1 : 0))
}
