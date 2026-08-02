#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const APP_ID = 'com.ram4dev.orca-wake-dev'
const WAKE_DEV_APP_NAME = 'Orca Wake Dev.app'
const WAKE_DEV_APP_DIRECTORIES = ['mac', 'mac-arm64']

export function createWakeDevBuildEnvironment(env = process.env) {
  const buildEnv = {
    ...env,
    ORCA_WAKE_DEV_BUILD: '1',
    ORCA_COMPUTER_MACOS_BUNDLE_ID: `${APP_ID}.computer-use`,
    ORCA_COMPUTER_MACOS_SIGN_IDENTITY: '-',
    ORCA_NOTIFICATION_STATUS_SIGN_IDENTITY: '-',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false'
  }
  for (const key of [
    'ORCA_MAC_RELEASE',
    'ORCA_MAC_HOURLY',
    'ORCA_MAC_ADHOC',
    'ORCA_BUILD_IDENTITY',
    'ORCA_POSTHOG_WRITE_KEY',
    'ORCA_DIAGNOSTICS_TOKEN_URL'
  ]) {
    delete buildEnv[key]
  }
  return buildEnv
}

export function buildMacWakeDev() {
  if (process.platform !== 'darwin') {
    throw new Error('Orca Wake Dev packaging is supported only on macOS.')
  }
  const env = createWakeDevBuildEnvironment()
  runPnpm(['run', 'build:desktop'], env)
  runPnpm(['run', 'build:computer-macos'], env)
  execFileSync(
    process.execPath,
    ['config/scripts/build-notification-status-macos.mjs', '--bundle-id', APP_ID],
    { env, stdio: 'inherit' }
  )
  runPnpm(['run', 'ensure:electron-runtime'], env)
  execFileSync(process.execPath, ['config/scripts/build-mac-local.mjs'], {
    env,
    stdio: 'inherit'
  })
  verifyWakeDevAppSignatures()
}

export function getWakeDevAppBundles(outputRoot = resolve('dist/wake-dev')) {
  return WAKE_DEV_APP_DIRECTORIES.map((directory) => join(outputRoot, directory, WAKE_DEV_APP_NAME))
}

export function verifyWakeDevAppSignatures(
  outputRoot = resolve('dist/wake-dev'),
  exec = execFileSync
) {
  for (const appBundle of getWakeDevAppBundles(outputRoot)) {
    exec('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'inherit' })
  }
}

function runPnpm(args, env) {
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    env,
    stdio: 'inherit'
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  buildMacWakeDev()
}
