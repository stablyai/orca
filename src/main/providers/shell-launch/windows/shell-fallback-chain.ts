import { win32 as pathWin32 } from 'node:path'
import { isWindowsPowerShellShellPath, resolveWindowsShellLaunchArgs } from './shell-args'
import type { WindowsPowerShellStartupCommandStaging, WindowsShellWslContext } from './shell-args'
import {
  resolveWindowsPowerShellSpawnChain,
  type WindowsPowerShellResolveOptions
} from './powershell-executable'

export type WindowsShellSpawnAttempt = {
  shellPath: string
  shellArgs: string[]
  effectiveCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: boolean
  startupCommandStaging?: WindowsPowerShellStartupCommandStaging
}

function toAttempt(
  shellPath: string,
  cwd: string,
  defaultCwd: string,
  wslContext: WindowsShellWslContext | undefined,
  startupCommand: string | undefined,
  startupCommandStaging: WindowsPowerShellStartupCommandStaging | undefined
): WindowsShellSpawnAttempt {
  const resolved = resolveWindowsShellLaunchArgs(
    shellPath,
    cwd,
    defaultCwd,
    wslContext,
    startupCommand,
    undefined,
    startupCommandStaging
  )
  return {
    shellPath,
    shellArgs: resolved.shellArgs,
    effectiveCwd: resolved.effectiveCwd,
    validationCwd: resolved.validationCwd,
    startupCommandDeliveredInShellArgs: resolved.startupCommandDeliveredInShellArgs === true,
    ...(resolved.startupCommandStaging
      ? { startupCommandStaging: resolved.startupCommandStaging }
      : {})
  }
}

/** Requested PowerShell → inbox PowerShell → cmd.exe, with absolute ConPTY-safe paths and per-shell argv.
 * Store alias stubs fail CreateProcessW (5); non-PowerShell requests retain their single-shell path. */
export function buildWindowsPowerShellSpawnAttempts(args: {
  shellPath: string
  cwd: string
  defaultCwd: string
  wslContext?: WindowsShellWslContext
  startupCommand?: string
  resolveOptions?: WindowsPowerShellResolveOptions
}): WindowsShellSpawnAttempt[] {
  if (!isWindowsPowerShellShellPath(args.shellPath)) {
    return []
  }
  const basename = pathWin32.basename(args.shellPath).toLowerCase()
  const chain = resolveWindowsPowerShellSpawnChain(basename, args.resolveOptions)
  let startupCommandStaging: WindowsPowerShellStartupCommandStaging | undefined
  try {
    const attempts: WindowsShellSpawnAttempt[] = []
    for (const candidate of chain) {
      const attempt = toAttempt(
        candidate,
        args.cwd,
        args.defaultCwd,
        args.wslContext,
        args.startupCommand,
        startupCommandStaging
      )
      startupCommandStaging ??= attempt.startupCommandStaging
      attempts.push(attempt)
    }
    return attempts
  } catch (error) {
    startupCommandStaging?.cleanup()
    throw error
  }
}
