// pnpm 12's npm_execpath is a native binary; feeding it to node broke hourly/adhoc macOS builds.

import { statSync } from 'node:fs'
import { win32 } from 'node:path'

const JS_CLI_EXTENSION = /\.[cm]?js$/i
// Why: `npx` and `npm run` export npm's own CLI as npm_execpath, which would run npm, not pnpm.
const NPM_OWN_CLI_PATH = /(?:^|[/\\])np[mx]-cli\.js$/i

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function resolvePnpmCliInvocation({
  npmExecPath = process.env.npm_execpath,
  nodeExecPath = process.execPath,
  platform = process.platform,
  pnpmHome = process.env.PNPM_HOME,
  fileExists = isFile
} = {}) {
  if (
    typeof npmExecPath === 'string' &&
    npmExecPath.length > 0 &&
    !NPM_OWN_CLI_PATH.test(npmExecPath)
  ) {
    if (JS_CLI_EXTENSION.test(npmExecPath)) {
      return { command: nodeExecPath, prefixArgs: [npmExecPath], shell: false }
    }
    return {
      command: npmExecPath,
      prefixArgs: [],
      shell: platform === 'win32' && /\.(cmd|bat)$/i.test(npmExecPath)
    }
  }

  // Native pnpm exec omits npm_execpath; setup installs no pnpm.cmd alongside pnpm.exe.
  if (platform === 'win32' && typeof pnpmHome === 'string' && win32.isAbsolute(pnpmHome)) {
    const native = [win32.join(pnpmHome, 'bin', 'pnpm.exe'), win32.join(pnpmHome, 'pnpm.exe')].find(
      (path) => fileExists(path)
    )
    if (native) {
      return { command: native, prefixArgs: [], shell: false }
    }
  }

  return {
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    prefixArgs: [],
    shell: platform === 'win32'
  }
}
