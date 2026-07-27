#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  resolveMacosComputerUseBundleId,
  resolveMacosPackageBundleIdentifiers
} from './macos-package-bundle-identifiers.mjs'

const { appBundleId } = resolveMacosPackageBundleIdentifiers()
// Why: resolves through the ORCA_COMPUTER_MACOS_BUNDLE_ID escape hatch so an
// explicit override still wins over the derived package identity.
const computerUseBundleId = resolveMacosComputerUseBundleId()

if (process.platform === 'win32') {
  runNodeScript('config/scripts/build-windows-cli-launcher.mjs')
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
  process.exit(0)
}

runPnpmScript('build:computer-macos', [], {
  ...process.env,
  ORCA_COMPUTER_MACOS_BUNDLE_ID: computerUseBundleId
})
runPnpmScript('build:notification-status-macos', ['--bundle-id', appBundleId])
process.exit(0)

function runPnpmScript(scriptName, scriptArgs = [], env = process.env) {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath
    ? process.execPath
    : process.platform === 'win32'
      ? 'pnpm.cmd'
      : 'pnpm'
  const args = npmExecPath
    ? [npmExecPath, 'run', scriptName, ...scriptArgs]
    : ['run', scriptName, ...scriptArgs]
  const result = spawnSync(command, args, { env, stdio: 'inherit' })

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
