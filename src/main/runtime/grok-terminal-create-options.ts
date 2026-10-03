import { pinGrokTerminalCreateOptions } from '../grok-accounts/launch'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { RuntimeStore } from './runtime-store-contract'

type GrokTerminalRuntime = {
  resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions>
  store?: RuntimeStore | null
}

export async function resolveGrokRuntimeLaunchOptions(
  runtime: GrokTerminalRuntime,
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions
): Promise<TerminalCreateOptions> {
  const resolved = await runtime.resolveAgentTerminalCreateOptions(workspace, opts)
  const defaultShell =
    process.platform === 'win32' ? runtime.store?.getSettings?.().terminalWindowsShell : undefined
  return pinGrokTerminalCreateOptions(resolved, workspace, defaultShell)
}
