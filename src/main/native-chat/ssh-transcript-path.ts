import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

// Encode connection and file in the engine’s single path string so local files cannot answer remote reads.
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

export function nativeChatTranscriptPathOnExecutionHost(
  statusRows: readonly HookRow[],
  sessionId: string,
  transcriptPath: string | undefined
): string | undefined {
  // Only host hook evidence may mint remote paths; client-provided forms cannot attest files.
  const requested =
    transcriptPath && !parseSshTranscriptPath(transcriptPath) ? transcriptPath : undefined
  const rows = statusRows.filter(
    (row) => row.providerSession?.id === sessionId && row.providerSession.transcriptPath
  )
  // Exact path attestation chooses the host; stale paths fall back to SSH.
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
