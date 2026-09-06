// pnpm 12's npm_execpath is a native binary; feeding it to node broke hourly/adhoc macOS builds.

const JS_CLI_EXTENSION = /\.[cm]?js$/i

export function resolvePnpmCliInvocation({
  npmExecPath = process.env.npm_execpath,
  nodeExecPath = process.execPath,
  platform = process.platform
} = {}) {
  if (typeof npmExecPath === 'string' && npmExecPath.length > 0) {
    if (JS_CLI_EXTENSION.test(npmExecPath)) {
      return { command: nodeExecPath, prefixArgs: [npmExecPath], shell: false }
    }
    return {
      command: npmExecPath,
      prefixArgs: [],
      shell: platform === 'win32' && /\.(cmd|bat)$/i.test(npmExecPath)
    }
  }

  return {
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    prefixArgs: [],
    shell: platform === 'win32'
  }
}
