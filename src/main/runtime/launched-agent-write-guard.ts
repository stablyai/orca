import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { OrcaRuntimeService } from './orca-runtime'
import type { LaunchedAgentForeground } from './launched-agent-foreground'

const SHELL_RETURN_MARKERS = ['\x1b[?2004', '\x1b]133;'] as const
const MARKER_CARRY_CHARS = Math.max(...SHELL_RETURN_MARKERS.map((marker) => marker.length)) - 1

export type LaunchedAgentWriteGuardRuntime = Pick<
  OrcaRuntimeService,
  'readLaunchedAgentForeground' | 'subscribeToTerminalData'
> &
  Partial<Pick<OrcaRuntimeService, 'launchedAgentHostProvesAgent'>>

export type LaunchedAgentWriteGuard = {
  beforeWrite: (ptyId: string) => Promise<void>
  dispose: () => void
}

/** Require fresh agent foreground before the first prompt write; ready signals can be shell prompts.
 * Reuse that proof for Enter until terminal output signals shell return, preserving paste timing. */
export function createLaunchedAgentWriteGuard(
  runtime: LaunchedAgentWriteGuardRuntime,
  agent: TuiAgent,
  /** Windows compatibility: write-unless-shell permits unknown; only proven shell refuses. */
  { unprovableHost = 'refuse' }: { unprovableHost?: 'refuse' | 'write-unless-shell' } = {}
): LaunchedAgentWriteGuard {
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
    // Subscribe before probing so shell return during the read cannot be missed.
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
    if (foreground === 'agent') {
      cleared = watch
      return
    }
    watch.unsubscribe()
    if (
      foreground === 'shell' ||
      unprovableHost === 'refuse' ||
      runtime.launchedAgentHostProvesAgent?.(ptyId) !== false
    ) {
      throw new Error('agent_not_in_foreground')
    }
  }
  return { beforeWrite, dispose }
}

/** Fresh worker launches share prompt-write guards; caller-supplied terminals have no launch to guard. */
export function createWorkerBriefWriteGuard(
  runtime: LaunchedAgentWriteGuardRuntime,
  agent: string | null | undefined,
  freshLaunch: boolean
): LaunchedAgentWriteGuard | null {
  return freshLaunch && isTuiAgent(agent)
    ? createLaunchedAgentWriteGuard(runtime, agent, { unprovableHost: 'write-unless-shell' })
    : null
}
