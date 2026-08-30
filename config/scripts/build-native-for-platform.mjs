#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  runNodeScript('config/scripts/build-windows-cli-launcher.mjs')
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
  process.exit(0)
}

runNodeScript('config/scripts/build-computer-macos.mjs')
runNodeScript('config/scripts/build-keyboard-layout-macos.mjs')
runNodeScript('config/scripts/build-notification-status-macos.mjs')
process.exit(0)

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' })
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1)
  }
}
