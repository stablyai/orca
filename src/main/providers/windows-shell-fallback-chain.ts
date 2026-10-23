import { win32 as pathWin32 } from 'node:path'
import { isWindowsPowerShellShellPath, resolveWindowsShellLaunchArgs } from './windows-shell-args'
import type {
  WindowsPowerShellStartupCommandStaging,
  WindowsShellWslContext
} from './windows-shell-args'
import {
  resolveWindowsPowerShellSpawnChain,
  type WindowsPowerShellResolveOptions
} from './windows-powershell-executable'

/** A single attempt in the Windows shell-spawn fallback chain: the absolute
 *  executable plus the launch args + cwd computed for it. */
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

/**
 * Build the ordered list of Windows PowerShell spawn attempts for a resolved
 * PowerShell shell path.
 *
 * Why: handing ConPTY a bare `pwsh.exe` lets Windows resolve it to the Store
 * App Execution Alias stub, whose CreateProcessW launch fails with
 * ERROR_ACCESS_DENIED (error code 5). Each attempt here is a real absolute
 * executable: requested PowerShell -> inbox Windows PowerShell -> cmd.exe, with
 * args recomputed per shell so the cmd.exe fallback still gets `chcp 65001`.
 *
 * Returns an empty array when `shellPath` is not a PowerShell family, so callers
 * keep their existing single-shell behavior for cmd.exe / wsl.exe / Git Bash.
 */
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
  const chain = resolveWindowsPowerShellSpawnChain(
    pathWin32.basename(args.shellPath).toLowerCase() === 'pwsh.exe' ? 'pwsh.exe' : 'powershell.exe',
    args.resolveOptions
  )
  const attempts: WindowsShellSpawnAttempt[] = []
  let startupCommandStaging: WindowsPowerShellStartupCommandStaging | undefined
  try {
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
