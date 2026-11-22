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

// monkey launches the default activity without requiring its component name.
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
