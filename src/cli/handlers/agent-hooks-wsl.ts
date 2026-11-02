import { WSL_CLI_CONTEXT_ENV, readWslCliContext } from '../../shared/wsl-cli-context'
import { getWslAccountTarget } from './account-wsl-location'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ManagedHookInvocation } from '../../main/claude/claude-hook-target'

export function wslHookInvocation(): { distro: string; context?: string } | null {
  const target = getWslAccountTarget(process.env.ORCA_CLI_CWD ?? process.cwd())
  if (!target) {
    return null
  }
  const context = process.env[WSL_CLI_CONTEXT_ENV]
  if (context) {
    readWslCliContext(context)
  }
  return { distro: target.wslDistro, ...(context ? { context } : {}) }
}

/** Old bridges have no guest authority: preserve the conventional native target from main. */
export function conventionalHookInvocation(): ManagedHookInvocation {
  return { target: { kind: 'system-default', configDir: join(homedir(), '.claude') } }
}
