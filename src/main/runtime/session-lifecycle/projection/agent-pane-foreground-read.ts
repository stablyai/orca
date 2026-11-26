import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-status/process/agent-process-recognition'

type ForegroundReads = {
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  confirmForegroundProcess?: (ptyId: string) => Promise<string | null>
}

/** Whether `agent` is in front of the pane, from a fresh read: cached names flap to shells, and a
 *  bare node may be an npm CLI. */
export async function readAgentPaneForeground(
  controller: ForegroundReads | null | undefined,
  ptyId: string,
  agent: TuiAgent
): Promise<boolean | 'unchecked' | 'team'> {
  if (!controller) {
    return 'unchecked'
  }
  const name = await controller.getForegroundProcess(ptyId).catch(() => null)
  const named = recognizeAgentProcess(name)?.agent
  if (named === agent && named !== 'claude-agent-teams') {
    return true
  }
  const fresh = (await controller.confirmForegroundProcess?.(ptyId).catch(() => null)) ?? null
  // No read, or only a bare node that an npm CLI also shows as, is no evidence either way.
  if (fresh === null && (name === null || isAgentForegroundWrapperProcess(name))) {
    return 'unchecked'
  }
  // An Agent Teams lead shows as `Orca`; restarting it would orphan its teammates.
  const recognized = recognizeAgentProcess(fresh)?.agent
  return recognized === 'claude-agent-teams' ? 'team' : recognized === agent
}
