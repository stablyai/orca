import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { readProcessCommandLine } from '../../daemon/endpoint/identity/daemon-process-inspection'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { acpLaunchPermission } from '../launch/acp-launch-permission-modes'

type Spec = Pick<AcpLaunchSpec, 'permissionModeConfig' | 'args'>

const FULL_ACCESS_NOTE = 'full-access'
const ASK_NOTE = 'ask'

/** What the spawning app tells the daemon about its launch, read back at a reattach. */
export const acpLaunchNote = (fullAccess: boolean): string =>
  fullAccess ? FULL_ACCESS_NOTE : ASK_NOTE

/** Whether the kept process's own arguments grant full access; null when arguments can't carry it.
 *  Read from the note its app left, else (a relay an older build spawned) from its command line;
 *  an unreadable one counts as granted, so a chat that says Ask never runs unprompted. */
async function keptLaunchFullAccess(
  spec: Spec,
  pid: number,
  note: string | undefined,
  readCommandLine: (pid: number) => Promise<string | undefined>
): Promise<boolean | null> {
  const plain = new Set(spec.args({ fullAccess: false, pluginDirs: [] }))
  const flags = spec.args({ fullAccess: true, pluginDirs: [] }).filter((arg) => !plain.has(arg))
  if (flags.length === 0) {
    return null
  }
  if (note === FULL_ACCESS_NOTE || note === ASK_NOTE) {
    return note === FULL_ACCESS_NOTE
  }
  const commandLine = await readCommandLine(pid).catch(() => undefined)
  if (commandLine === undefined) {
    return true
  }
  const args = new Set(commandLine.split(/[\0\s]+/))
  return flags.every((flag) => args.has(flag))
}

/**
 * A launch's permission facts. A kept agent runs with the arguments of the app that started it,
 * not this launch's: full access they granted stays until a restart takes it away, so it is what
 * the chat reports running, and a chat now in another mode restarts it at its next send.
 */
export async function keptAcpLaunchPermission(
  spec: Spec,
  relayed: {
    reattached: boolean
    child: { pid: number; attachResult?: { launchNote?: string } | null }
  } | null,
  launch: { fullAccess: boolean },
  acquire: { permissionMode?: AgentChatPermissionChoice },
  readCommandLine = (pid: number) => readProcessCommandLine(pid, process.platform)
) {
  const kept = relayed?.reattached
    ? await keptLaunchFullAccess(
        spec,
        relayed.child.pid,
        relayed.child.attachResult?.launchNote,
        readCommandLine
      )
    : null
  const permission = acquire.permissionMode
  return kept === null || kept === launch.fullAccess
    ? acpLaunchPermission(spec, launch.fullAccess, permission)
    : acpLaunchPermission(spec, kept, kept ? 'full-access' : permission)
}
