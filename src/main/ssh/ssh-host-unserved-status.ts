/** What a connect publishes when the managed server doesn't serve the host; there is no fallback. */
import type { SshManagedServerStatus } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'

type UnservedDecision = Extract<HostServerOnConnectResult, { route: 'unserved' }>

// Why `kind: 'relay'`: the published status keeps its shipped shape; it now means "not served".
export function unservedServerStatus(
  decision: UnservedDecision
): Extract<SshManagedServerStatus, { kind: 'relay' }> {
  return {
    kind: 'relay',
    reason: decision.reason,
    ...(decision.detail ? { detail: decision.detail } : {}),
    ...(decision.terminals !== undefined ? { terminals: decision.terminals } : {}),
    ...(decision.terminalsElsewhere ? { terminalsElsewhere: true } : {}),
    ...(decision.canLeaveBehind ? { canLeaveBehind: true } : {}),
    ...(decision.held ? { held: true } : {}),
    ...(decision.contactLost ? { contactLost: true } : {}),
    ...(decision.bridged ? { bridged: true } : {})
  }
}

const HELD_MOVE_MESSAGE =
  'Orca paused moving this host’s projects to its managed server because it couldn’t confirm the server’s copy. Nothing is lost: the host keeps its projects and stays locked until the move finishes. Connect again to resume. If the server can’t come back, stop or forget it in Settings > Managed servers.'

const NOEXEC_MESSAGE =
  'This host doesn’t allow running programs from ~/.orca-remote, so Orca can’t start its server there. This usually means the home folder is mounted with noexec. Ask the host’s administrator to allow running programs there, then connect again.'

const CONTACT_LOST_MESSAGE =
  'Orca lost contact with this host while setting up its server. Nothing on the host was stopped. Connect again to continue.'

/** Untranslated twin of the renderer's status line, for logs and callers without the catalog. */
export function unservedHostServerMessage(decision: UnservedDecision): string {
  if (decision.held && (decision.reason === 'failed' || decision.reason === 'deferred')) {
    return HELD_MOVE_MESSAGE
  }
  switch (decision.reason) {
    case 'orcad_unavailable':
      return decision.detail === 'runtime_noexec'
        ? NOEXEC_MESSAGE
        : 'This SSH host isn’t supported by this version of Orca. To keep using it, install an older version of Orca.'
    case 'relay_terminals_live':
    case 'relay_terminals_unverifiable':
      return 'Terminals started by an older version of Orca are still running on this host, and they don’t stop on their own. Close them in that version of Orca or end them on the host, then reconnect.'
    case 'refused':
      return decision.detail ?? 'Orca couldn’t set up its server on this host.'
    case 'source_changed':
      return 'An older version of Orca changed this host’s projects. Move those changes to its managed server in SSH Hosts settings to continue.'
    case 'deferred':
    case 'failed':
      return decision.contactLost
        ? CONTACT_LOST_MESSAGE
        : 'Orca couldn’t start its server on this host. Try connecting again.'
  }
}
