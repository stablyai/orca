import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

// Why: the transcript engine addresses a file by one path string. A transcript on an SSH host is
// named by its connection as well, so both travel in that string and no local file can answer.
const SSH_TRANSCRIPT_PATH_PREFIX = 'orca-ssh-transcript:'

export type SshTranscriptLocation = { connectionId: string; remotePath: string }

export function toSshTranscriptPath(connectionId: string, remotePath: string): string {
  return `${SSH_TRANSCRIPT_PATH_PREFIX}${encodeURIComponent(connectionId)}:${remotePath}`
}

export function parseSshTranscriptPath(path: string): SshTranscriptLocation | null {
  if (!path.startsWith(SSH_TRANSCRIPT_PATH_PREFIX)) {
    return null
  }
  const rest = path.slice(SSH_TRANSCRIPT_PATH_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) {
    return null
  }
  return {
    connectionId: decodeURIComponent(rest.slice(0, separator)),
    remotePath: rest.slice(separator + 1)
  }
}

type HookRow = Pick<AgentStatusIpcPayload, 'connectionId' | 'providerSession'>

/** The path native chat reads: a session the hook store puts on an SSH host is read there, never here. */
export function nativeChatTranscriptPathOnExecutionHost(
  statusRows: readonly HookRow[],
  sessionId: string,
  transcriptPath: string | undefined
): string | undefined {
  // Only the host mints this form; a client-supplied one would name a file the hook never attested.
  const requested =
    transcriptPath && !parseSshTranscriptPath(transcriptPath) ? transcriptPath : undefined
  const rows = statusRows.filter(
    (row) => row.providerSession?.id === sessionId && row.providerSession.transcriptPath
  )
  // Why: the row attesting the requested path decides the host; a stale path falls back to SSH.
  const row =
    rows.find((candidate) => candidate.providerSession?.transcriptPath === requested) ??
    rows.find(isSshRow)
  const remotePath = row?.providerSession?.transcriptPath
  return row && isSshRow(row) && remotePath
    ? toSshTranscriptPath(row.connectionId, remotePath)
    : requested
}

function isSshRow(row: HookRow): row is HookRow & { connectionId: string } {
  return row.connectionId ? !isWslHookRelayConnectionId(row.connectionId) : false
}
