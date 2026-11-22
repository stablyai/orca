import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-status/process/agent-process-recognition'

type ForegroundReads = {
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  confirmForegroundProcess?: (ptyId: string) => Promise<string | null>
}

/** A fresh foreground read: cached names flap to shells, and a bare node may be an npm Claude. */
export async function readClaudeForeground(
  controller: ForegroundReads | null | undefined,
  ptyId: string
): Promise<boolean | 'unchecked' | 'team'> {
  if (!controller) {
    return 'unchecked'
  }
  const name = await controller.getForegroundProcess(ptyId).catch(() => null)
  if (recognizeAgentProcess(name)?.agent === 'claude') {
    return true
  }
  const fresh = (await controller.confirmForegroundProcess?.(ptyId).catch(() => null)) ?? null
  // No read, or only a bare node that an npm Claude also shows as, is no evidence either way.
  if (fresh === null && (name === null || isAgentForegroundWrapperProcess(name))) {
    return 'unchecked'
  }
  // An Agent Teams lead shows as `Orca`; restarting it would orphan its teammates.
  const agent = recognizeAgentProcess(fresh)?.agent
  return agent === 'claude-agent-teams' ? 'team' : agent === 'claude'
}
