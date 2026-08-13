export function resolvePnpmCliSpawn(
  args,
  {
    platform = process.platform,
    nodePath = process.execPath,
    npmExecPath = process.env.npm_execpath
  } = {}
) {
  if (platform !== 'win32') {
    return { command: 'pnpm', args }
  }
  if (!npmExecPath) {
    throw new Error('Run this command through pnpm so its Windows CLI path is available.')
  }
  return { command: nodePath, args: [npmExecPath, ...args] }
}
