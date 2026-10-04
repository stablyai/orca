export function isWindowsArm64(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): boolean {
  return platform === 'win32' && architecture === 'arm64'
}
