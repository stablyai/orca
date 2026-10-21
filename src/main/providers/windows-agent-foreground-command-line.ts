import { resolveWindowsForegroundIdentity } from './windows-agent-foreground-process'
import { queryWindowsPaneProcessInventory } from './windows-foreground-process-rows'

/** Command line of the pane's foreground agent process, from one fresh native table read. */
export async function resolveWindowsAgentForegroundCommandLine(
  shellPid: number,
  foregroundProcess: string
): Promise<string | null> {
  const inventory = await queryWindowsPaneProcessInventory(shellPid, { fresh: true })
  if (!inventory) {
    return null
  }
  const { processId } = resolveWindowsForegroundIdentity(
    inventory.candidates,
    foregroundProcess,
    undefined
  )
  return processId === undefined
    ? null
    : (inventory.candidates.find((candidate) => candidate.pid === processId)?.command ?? null)
}
