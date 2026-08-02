// Pure arg-building for `adb` app install/launch. No process execution here:
// the caller prepends the resolved adb binary path to every arg array.

// `adb -s <serial> install [-r] <apkPath>` (-r reinstalls over an existing app).
export function installApkArgs(
  serial: string,
  apkPath: string,
  options?: { reinstall?: boolean }
): string[] {
  const args = ['-s', serial, 'install']
  if (options?.reinstall) {
    args.push('-r')
  }
  args.push(apkPath)
  return args
}

// `adb -s <serial> shell am start -n <package>/<activity>` when an activity is
// known; otherwise launch the default LAUNCHER activity via monkey, which does
// not require the caller to resolve the entry-point component name.
export function launchAppArgs(serial: string, packageName: string, activity?: string): string[] {
  if (activity && activity.trim() !== '') {
    return ['-s', serial, 'shell', 'am', 'start', '-n', `${packageName}/${activity}`]
  }
  return [
    '-s',
    serial,
    'shell',
    'monkey',
    '-p',
    packageName,
    '-c',
    'android.intent.category.LAUNCHER',
    '1'
  ]
}
