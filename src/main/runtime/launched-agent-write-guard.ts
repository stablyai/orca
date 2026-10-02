import type { TuiAgent } from '../../shared/tui-agent'
import type { OrcaRuntimeService } from './orca-runtime'
import type { LaunchedAgentForeground } from './launched-agent-foreground'

/** A shell back at its prompt turns bracketed paste on, and Orca's shell integration marks it. */
const SHELL_RETURN_MARKERS = ['\x1b[?2004', '\x1b]133;'] as const
const MARKER_CARRY_CHARS = Math.max(...SHELL_RETURN_MARKERS.map((marker) => marker.length)) - 1

export type LaunchedAgentWriteGuardRuntime = Pick<
  OrcaRuntimeService,
  'readLaunchedAgentForeground' | 'subscribeToTerminalData'
>

/**
 * The check before each write of a launch prompt: the paste, its Enter, and Codex's second Enter.
 * A write needs a fresh read that finds the agent in front; a shell, or a host that cannot tell,
 * refuses it, since a ready signal alone can come from a shell back at its prompt. Once a read finds
 * the agent, later writes reuse it until the terminal shows a shell coming back to its prompt, so
 * Enter follows the paste on the desktop's timing instead of waiting out another process read.
 */
export function createLaunchedAgentWriteGuard(
  runtime: LaunchedAgentWriteGuardRuntime,
  agent: TuiAgent
): { beforeWrite: (ptyId: string) => Promise<void>; dispose: () => void } {
  let cleared: { ptyId: string; shellMayHaveReturned: boolean; unsubscribe: () => void } | null =
    null
  const dispose = (): void => {
    cleared?.unsubscribe()
    cleared = null
  }
  const beforeWrite = async (ptyId: string): Promise<void> => {
    if (cleared?.ptyId === ptyId && !cleared.shellMayHaveReturned) {
      return
    }
    dispose()
    let carry = ''
    const watch = { ptyId, shellMayHaveReturned: false, unsubscribe: (): void => {} }
    // Subscribed before the read, so a shell that returns while it runs is not missed.
    watch.unsubscribe = runtime.subscribeToTerminalData(ptyId, (data) => {
      const window = carry + data
      carry = window.slice(-MARKER_CARRY_CHARS)
      if (SHELL_RETURN_MARKERS.some((marker) => window.includes(marker))) {
        watch.shellMayHaveReturned = true
      }
    })
    let foreground: LaunchedAgentForeground
    try {
      foreground = await runtime.readLaunchedAgentForeground(ptyId, agent)
    } catch (error) {
      watch.unsubscribe()
      throw error
    }
    if (foreground !== 'agent') {
      watch.unsubscribe()
      throw new Error('agent_not_in_foreground')
    }
    cleared = watch
  }
  return { beforeWrite, dispose }
}
