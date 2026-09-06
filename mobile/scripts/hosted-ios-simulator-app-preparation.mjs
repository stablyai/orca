import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildAndInstallHostedIosSimulatorApp,
  hostedIosSimulatorAppPath,
  installHostedIosSimulatorApp
} from './hosted-ios-simulator-app-build.mjs'

const execFileAsync = promisify(execFile)
const IOS_BUNDLE_IDENTIFIER = 'com.stably.orca.mobile'

export function hostedIosSimulatorAppPreparation({
  deviceUdid,
  reuseNativeInstall,
  skipNativeBuild,
  worktree,
  runCommand = execFileAsync
}) {
  const appPath = hostedIosSimulatorAppPath(worktree)
  if (reuseNativeInstall) {
    return {
      label: 'existing native simulator app',
      run: async () => {
        const { stdout } = await runCommand('xcrun', [
          'simctl',
          'get_app_container',
          deviceUdid,
          IOS_BUNDLE_IDENTIFIER,
          'app'
        ])
        return stdout.trim()
      }
    }
  }
  if (skipNativeBuild) {
    return {
      label: 'cached native simulator app install',
      run: async () => {
        await installHostedIosSimulatorApp({ deviceUdid, appPath, runCommand })
        return appPath
      }
    }
  }
  return {
    label: 'native simulator app build',
    run: () => buildAndInstallHostedIosSimulatorApp({ deviceUdid, worktree, runCommand })
  }
}
