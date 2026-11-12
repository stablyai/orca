import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { PaneAgentCommandLineReader } from '../../../shared/agent-hook-listener/permissions/pane-permission-observation'
import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../../shared/agent-status/process/agent-process-recognition'
import {
  readPosixPaneAgentCommandLine,
  selectUniqueRootAgentCommand
} from '../../../shared/agent-status/process/posix-pane-agent-command-line'
import { queryWindowsPaneProcessInventory } from '../../providers/windows-foreground-process-rows'
import type { LocalPtyInventoryReader } from './local-tmux-managed-pty'

async function readWindowsRootAgentCommandLine(
  shellPid: number,
  agent: TuiAgent
): Promise<string | null> {
  const inventory = await queryWindowsPaneProcessInventory(shellPid, { fresh: true })
  if (!inventory) {
    return null
  }
  const matching = inventory.candidates.filter(
    (candidate) =>
      (
        recognizeAgentProcessFromCommandLine(candidate.command) ??
        recognizeAgentProcess(candidate.name)
      )?.agent === agent
  )
  return selectUniqueRootAgentCommand(matching, inventory.candidates)
}

/** Read the root agent process's OS command line for a pane owned by this host's PTY provider. */
export function createLocalPaneAgentCommandLineReader(
  readInventory: LocalPtyInventoryReader
): PaneAgentCommandLineReader {
  return async (paneKey, agent, sender) => {
    const row = await readInventory(paneKey, { bySpawnPaneKey: true }).catch(() => null)
    if (!row?.rootProcessId || row.wslDistro) {
      return null
    }
    return process.platform === 'win32'
      ? readWindowsRootAgentCommandLine(row.rootProcessId, agent)
      : readPosixPaneAgentCommandLine(row.rootProcessId, agent, sender)
  }
}
