import { AgentResumeShellMismatchError } from '../../shared/agent-resume-command'
import type { AgentResumeCommand } from '../../shared/agent-resume-command'
import { win32 as pathWin32 } from 'node:path'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'
import type { WindowsShellWslContext } from './windows-shell-args'
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
}

function toAttempt(
  shellPath: string,
  cwd: string,
  defaultCwd: string,
  wslContext: WindowsShellWslContext | undefined,
  startupCommand: string | undefined,
  agentResume?: AgentResumeCommand
): WindowsShellSpawnAttempt {
  const resolved = resolveWindowsShellLaunchArgs(
    shellPath,
    cwd,
    defaultCwd,
    wslContext,
    startupCommand,
    undefined,
    agentResume
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
  agentResume?: AgentResumeCommand
  resolveOptions?: WindowsPowerShellResolveOptions
}): WindowsShellSpawnAttempt[] {
  const basename = pathWin32.basename(args.shellPath).toLowerCase()
  if (basename !== 'pwsh.exe' && basename !== 'powershell.exe') {
    return []
  }
  const chain = resolveWindowsPowerShellSpawnChain(basename, args.resolveOptions)
  return chain.map((candidate) => {
    try {
      return toAttempt(
        candidate,
        args.cwd,
        args.defaultCwd,
        args.wslContext,
        args.startupCommand,
        args.agentResume
      )
    } catch (error) {
      if (error instanceof AgentResumeShellMismatchError) {
        // Why a bare attempt, not a dropped one: filtering here can empty the
        // chain (or rethrow at index 0) and cost the user the terminal itself.
        // The shell must still open; the resume is dropped for this shell, and
        // the delivery-time resolver makes the same call so nothing mis-quoted
        // is written either. The legacy command is dropped with it — its quoting
        // was authored for the requested shell, not this fallback.
        return toAttempt(candidate, args.cwd, args.defaultCwd, args.wslContext, undefined)
      }
      throw error
    }
  })
}
