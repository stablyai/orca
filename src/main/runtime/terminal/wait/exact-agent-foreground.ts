import { recognizeAgentProcess } from '../../../../shared/agent-status/process/agent-process-recognition'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import { judgeTerminalForeground } from '../lifecycle/terminal-foreground-group'
import { readTerminalProcessRows } from '../../../pty/process-retirement/terminal-process-rows'
import type { ExactAgentName, LaunchedAgentForeground } from './launched-agent-foreground'

/** `agent` only when the program in front is `agent` itself: the launched-agent read, which on a
 *  local host admits any non-shell, then a fresh process-table name at the owner that names it. */
export async function readExactAgentForeground(
  runtime: {
    readLaunchedAgentForeground(
      ptyId: string,
      agent: TuiAgent,
      exact?: ExactAgentName
    ): Promise<LaunchedAgentForeground>
  },
  controller: Pick<RuntimePtyController, 'confirmForegroundProcess'> | null | undefined,
  ptyId: string,
  agent: TuiAgent
): Promise<LaunchedAgentForeground> {
  const exact: ExactAgentName = { named: false }
  const foreground = await runtime.readLaunchedAgentForeground(ptyId, agent, exact)
  if (foreground !== 'agent' || exact.named) {
    return foreground
  }
  return confirmAgentNameAtOwner(controller, ptyId, agent)
}

/** The same exact read for a local owner without foreground observation, scoped to the terminal of
 *  the root PID its reattach discovery listed rather than refetching the owner's every session. */
export async function readAdoptedRootAgentForeground(
  controller: Pick<RuntimePtyController, 'confirmForegroundProcess'> | null | undefined,
  rootPid: number,
  ptyId: string,
  agent: TuiAgent
): Promise<LaunchedAgentForeground> {
  try {
    const rows = await readTerminalProcessRows(rootPid)
    const foreground = rows ? judgeTerminalForeground(rows, rootPid, agent) : 'unknown'
    return foreground === 'agent'
      ? await confirmAgentNameAtOwner(controller, ptyId, agent)
      : foreground
  } catch {
    return 'unknown'
  }
}

async function confirmAgentNameAtOwner(
  controller: Pick<RuntimePtyController, 'confirmForegroundProcess'> | null | undefined,
  ptyId: string,
  agent: TuiAgent
): Promise<LaunchedAgentForeground> {
  const name = (await controller?.confirmForegroundProcess?.(ptyId)) ?? null
  return recognizeAgentProcess(name)?.agent === agent ? 'agent' : 'unknown'
}
