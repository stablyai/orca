import { win32 as pathWin32 } from 'node:path'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'
import type { WindowsShellWslContext } from './windows-shell-args'
import {
  resolveWindowsPowerShellSpawnChain,
  type WindowsPowerShellResolveOptions
} from './windows-powershell-executable'

export type WindowsShellSpawnAttempt = {
  shellPath: string
  shellArgs: string[]
  effectiveCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: boolean
}

function toAttempt(
  shellPath: string,
  cwd: string,
  defaultCwd: string,
  wslContext: WindowsShellWslContext | undefined,
  startupCommand: string | undefined
): WindowsShellSpawnAttempt {
  const resolved = resolveWindowsShellLaunchArgs(
    shellPath,
    cwd,
    defaultCwd,
    wslContext,
    startupCommand
  )
  return {
    shellPath,
    shellArgs: resolved.shellArgs,
    effectiveCwd: resolved.effectiveCwd,
    validationCwd: resolved.validationCwd,
    startupCommandDeliveredInShellArgs: resolved.startupCommandDeliveredInShellArgs === true
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
  const basename = pathWin32.basename(args.shellPath).toLowerCase()
  if (basename !== 'pwsh.exe' && basename !== 'powershell.exe') {
    return []
  }
  const chain = resolveWindowsPowerShellSpawnChain(basename, args.resolveOptions)
  return chain.map((candidate) =>
    toAttempt(candidate, args.cwd, args.defaultCwd, args.wslContext, args.startupCommand)
  )
}
