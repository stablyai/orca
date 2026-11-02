import type { NodeDistMirrorAttempt } from '../../shared/node-dist-mirror'
import type { SshManagedServerStatus } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'

type UnservedDecision = Extract<HostServerOnConnectResult, { route: 'unserved' }>

// Keep shipped kind:relay wire compatibility even though it now means unserved.
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
    ...(decision.nodeDownloadBlocked ? { nodeDownloadBlocked: decision.nodeDownloadBlocked } : {}),
    ...(decision.bridged ? { bridged: true } : {})
  }
}

const HELD_MOVE_MESSAGE =
  'Orca paused moving this host’s projects to its Orca server because it couldn’t confirm the server’s copy. Nothing is lost: the host keeps its projects and stays locked until the move finishes. Connect again to resume. If the server can’t come back, stop or forget it in Settings > Orca on your SSH hosts.'

// Host-fixable reasons carry their own remedy; others fall back to the unsupported-version line.
const UNAVAILABLE_MESSAGES: Record<string, string> = {
  runtime_noexec:
    'This host doesn’t allow running programs from ~/.orca-remote, so Orca can’t start its server there. This usually means the home folder is mounted with noexec. Ask the host’s administrator to allow running programs there, then connect again.',
  windows_build_unsupported:
    'This host runs a version of Windows older than Windows 10 and Windows Server 2016, so it can’t run Orca’s server. Use a host with a newer version of Windows, or a Linux or macOS host.',
  windows_no_extractor:
    'This Windows host has neither tar.exe nor PowerShell’s Expand-Archive, so Orca can’t unpack its server there. Install Windows PowerShell 5.1 on the host, then connect again.'
}

const CONTACT_LOST_MESSAGE =
  'Orca lost contact with this host while setting up its server. Nothing on the host was stopped. Connect again to continue.'

const NODE_DOWNLOAD_BLOCKED_MESSAGES: Record<NodeDistMirrorAttempt, string> = {
  unset:
    'Neither this computer nor this host could download Node.js, which Orca’s server needs. Set a Node.js download mirror in Settings > Advanced > Network, or check the network on both machines, then connect again.',
  tried:
    'Neither this computer nor this host could download Node.js, including from the Node.js download mirror. Check the mirror in Settings > Advanced > Network, then connect again.',
  unsupported:
    'Neither this computer nor this host could download Node.js, which Orca’s server needs. Check the network or proxy on both machines, then connect again.'
}

/** Reuse untranslated status wording for logs/clients without the catalog. */
export function unservedHostServerMessage(decision: UnservedDecision): string {
  if (decision.held && (decision.reason === 'failed' || decision.reason === 'deferred')) {
    return HELD_MOVE_MESSAGE
  }
  switch (decision.reason) {
    case 'orcad_unavailable':
      return (
        (decision.detail && UNAVAILABLE_MESSAGES[decision.detail]) ||
        'This SSH host isn’t supported by this version of Orca. To keep using it, install an older version of Orca.'
      )
    case 'relay_terminals_live':
    case 'relay_terminals_unverifiable':
      return 'Terminals started by an older version of Orca are still running on this host, and they don’t stop on their own. Close them in that version of Orca or end them on the host, then reconnect.'
    case 'refused':
      return decision.detail ?? 'Orca couldn’t set up its server on this host.'
    case 'source_changed':
      return 'This computer has projects or folders for this host that its Orca server doesn’t have yet, often added by an older version of Orca. Move them to this host’s Orca server in SSH Hosts settings to continue.'
    case 'deferred':
    case 'failed':
      if (decision.contactLost) {
        return CONTACT_LOST_MESSAGE
      }
      return decision.nodeDownloadBlocked
        ? NODE_DOWNLOAD_BLOCKED_MESSAGES[decision.nodeDownloadBlocked.mirror]
        : 'Orca couldn’t start its server on this host. Try connecting again.'
  }
}
