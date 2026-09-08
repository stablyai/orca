import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const IOS_BUNDLE_IDENTIFIER = 'com.stably.orca.mobile'

export async function buildAndInstallHostedIosSimulatorApp({
  deviceUdid,
  worktree,
  runCommand = execFileAsync
}) {
  const derivedDataPath = hostedIosSimulatorDerivedDataPath(worktree)
  const mobileRoot = path.join(worktree, 'mobile')
  await runCommand(
    'xcodebuild',
    [
      '-workspace',
      'ios/Orca.xcworkspace',
      '-scheme',
      'Orca',
      '-configuration',
      'Debug',
      '-sdk',
      'iphonesimulator',
      '-destination',
      `platform=iOS Simulator,id=${deviceUdid}`,
      '-derivedDataPath',
      derivedDataPath,
      'build'
    ],
    { cwd: mobileRoot, maxBuffer: 64 * 1024 * 1024 }
  )
  const appPath = hostedIosSimulatorAppPath(worktree)
  await installHostedIosSimulatorApp({ deviceUdid, appPath, runCommand })
  return appPath
}

export function hostedIosSimulatorAppPath(worktree) {
  return path.join(
    hostedIosSimulatorDerivedDataPath(worktree),
    'Build',
    'Products',
    'Debug-iphonesimulator',
    'Orca.app'
  )
}

function hostedIosSimulatorDerivedDataPath(worktree) {
  return path.join(worktree, 'mobile', 'ios', 'build', 'hosted-webview-e2e')
}

export async function installHostedIosSimulatorApp({
  deviceUdid,
  appPath,
  runCommand = execFileAsync
}) {
  // Why: simctl install preserves AsyncStorage, which can resume a stale host or package.
  await runCommand('xcrun', ['simctl', 'uninstall', deviceUdid, IOS_BUNDLE_IDENTIFIER]).catch(
    () => undefined
  )
  await runCommand('xcrun', ['simctl', 'install', deviceUdid, appPath], {
    maxBuffer: 4 * 1024 * 1024
  })
  await runCommand('xcrun', [
    'simctl',
    'spawn',
    deviceUdid,
    'defaults',
    'write',
    IOS_BUNDLE_IDENTIFIER,
    'EXDevMenuShowFloatingActionButton',
    '-bool',
    'false'
  ])
}
