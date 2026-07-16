import { win32 as pathWin32 } from 'node:path'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'
import type { WindowsShellWslContext } from './windows-shell-args'
import {
  resolveWindowsPowerShellSpawnChain,
  type WindowsPowerShellResolveOptions
} from './windows-powershell-executable'
import { buildWindowsCodexShellHandoffAttempt } from './windows-codex-shell-handoff'

/** A single attempt in the Windows shell-spawn fallback chain: the absolute
 *  executable plus the launch args + cwd computed for it. */
export type WindowsShellSpawnAttempt = {
  shellPath: string
  shellArgs: string[]
  /** User-selected shell represented by a lightweight launch host. */
  logicalShellPath?: string
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
  const basename = pathWin32.basename(args.shellPath).toLowerCase()
  if (basename !== 'pwsh.exe' && basename !== 'powershell.exe') {
    return []
  }
  const chain = resolveWindowsPowerShellSpawnChain(basename, args.resolveOptions)
  return chain.map((candidate) =>
    toAttempt(candidate, args.cwd, args.defaultCwd, args.wslContext, args.startupCommand)
  )
}

export function prependWindowsCodexShellHandoffAttempt(args: {
  attempts: WindowsShellSpawnAttempt[]
  cwd: string
  defaultCwd: string
  wslContext?: WindowsShellWslContext
  startupCommand?: string
  launchAgent?: string
  windowsCodexShellHandoff?: boolean
  env: Record<string, string>
}): WindowsShellSpawnAttempt[] {
  const powerShellAttempt = args.attempts[0]
  if (!powerShellAttempt) {
    return args.attempts
  }
  const powerShellBasename = pathWin32.basename(powerShellAttempt.shellPath).toLowerCase()
  if (powerShellBasename !== 'pwsh.exe' && powerShellBasename !== 'powershell.exe') {
    return args.attempts
  }
  const handoff = buildWindowsCodexShellHandoffAttempt({
    fallbackAttempts: args.attempts,
    cwd: args.cwd,
    defaultCwd: args.defaultCwd,
    wslContext: args.wslContext,
    startupCommand: args.startupCommand,
    launchAgent: args.launchAgent,
    windowsCodexShellHandoff: args.windowsCodexShellHandoff,
    env: args.env
  })
  // Why: keep the established PowerShell -> cmd chain behind the optimized
  // host so an unavailable Node/native Codex target still fails open safely.
  return handoff ? [handoff, ...args.attempts] : args.attempts
}
