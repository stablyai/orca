import { win32 as pathWin32 } from 'node:path'
import { resolveWindowsShellLaunchArgs } from './shell-args'
import type { WindowsShellWslContext } from './shell-args'
import { resolveWindowsPowerShellSpawnChain } from './powershell-executable'
import { isPreviewPwshPath } from './pwsh-discovery'
import {
  buildWindowsPwshNotFoundNotices,
  type WindowsPwshNotFoundNotices
} from './pwsh-not-found-notice'

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
  startupNotice?: string
): WindowsShellSpawnAttempt {
  const resolved = resolveWindowsShellLaunchArgs(
    shellPath,
    cwd,
    defaultCwd,
    wslContext,
    startupCommand,
    undefined,
    startupNotice
  )
  return {
    shellPath,
    shellArgs: resolved.shellArgs,
    effectiveCwd: resolved.effectiveCwd,
    validationCwd: resolved.validationCwd,
    startupCommandDeliveredInShellArgs: resolved.startupCommandDeliveredInShellArgs === true
  }
}

function pwshNotFoundNotice(
  fallbackShellPath: string,
  notices: WindowsPwshNotFoundNotices
): string {
  const notice =
    pathWin32.basename(fallbackShellPath).toLowerCase() === 'powershell.exe'
      ? notices.windowsPowerShell
      : notices.commandPrompt
  return `[${notice}]`
}

/** Requested PowerShell → inbox PowerShell → cmd.exe, with absolute ConPTY-safe paths and per-shell argv.
 * Store alias stubs fail CreateProcessW (5); non-PowerShell requests retain their single-shell path. */
export async function buildWindowsPowerShellSpawnAttempts(args: {
  shellPath: string
  cwd: string
  defaultCwd: string
  wslContext?: WindowsShellWslContext
  startupCommand?: string
  /** The environment the terminal will get, so PATH lookups see what the shell will see. */
  env: NodeJS.ProcessEnv
  /** The shell setting as requested (name or path) and the PowerShell version setting. */
  requestedShell: string
  powerShellImplementation: string | undefined
  /** Translated by main; English when an older client did not send them. */
  pwshNotFoundNotices?: WindowsPwshNotFoundNotices
}): Promise<WindowsShellSpawnAttempt[]> {
  const basename = pathWin32.basename(args.shellPath).toLowerCase()
  if (basename !== 'pwsh.exe' && basename !== 'powershell.exe') {
    return []
  }
  const chain = await resolveWindowsPowerShellSpawnChain(basename, {
    env: args.env,
    settingKey: `${args.requestedShell}|${args.powerShellImplementation ?? ''}`,
    preferPreview: isPreviewPwshPath(args.requestedShell)
  })
  // A missing PowerShell 7 is announced by the fallback shell itself.
  const pwshMissing =
    basename === 'pwsh.exe' && pathWin32.basename(chain[0] ?? '').toLowerCase() !== 'pwsh.exe'
  const notices = pwshMissing
    ? (args.pwshNotFoundNotices ?? buildWindowsPwshNotFoundNotices())
    : undefined
  return chain.map((candidate) =>
    toAttempt(
      candidate,
      args.cwd,
      args.defaultCwd,
      args.wslContext,
      args.startupCommand,
      notices ? pwshNotFoundNotice(candidate, notices) : undefined
    )
  )
}
