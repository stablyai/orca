import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../shared/wsl-hook-relay-contract'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import {
  blockedWslDistroForPath,
  runAsWslUserAct,
  wslDistroForPath
} from '../wsl/wsl-unc-access-gate'
import { wslGatedAccess } from './wsl-transcript-fs-access'
import { WSL_TRANSCRIPT_RUNNING_LEASE_MS } from './wsl-transcript-running-admission'
import { agentHookServer } from '../agent-hooks/server'
import { nativeChatTranscriptPathOnExecutionHost } from './ssh-transcript-path'

type HookRow = Pick<AgentStatusIpcPayload, 'connectionId' | 'providerSession'>

/** The distro an opened chat's transcript lives in: its UNC path, else the WSL relay that reported it. */
export function nativeChatTranscriptDistro(
  statusRows: readonly HookRow[],
  sessionId: string,
  transcriptPath: string | undefined
): string | null {
  const fromPath = transcriptPath ? wslDistroForPath(transcriptPath) : null
  if (fromPath || process.platform !== 'win32') {
    return fromPath
  }
  const relay = statusRows.find(
    (row) => row.providerSession?.id === sessionId && isWslHookRelayConnectionId(row.connectionId)
  )?.connectionId
  return relay ? relay.slice(WSL_HOOK_RELAY_CONNECTION_PREFIX.length) || null : null
}

/**
 * Opening or paging a chat is a user act: start its stopped distro so the gated transcript reads
 * that follow can run (E9). Later watch and poll reads stay background and never start it.
 */
export async function wakeNativeChatTranscriptDistro(distro: string | null): Promise<void> {
  if (
    !distro ||
    !(await blockedWslDistroForPath('', distro, { leaseMs: WSL_TRANSCRIPT_RUNNING_LEASE_MS }))
  ) {
    return
  }
  // The read that follows reports any failure; this touch only has to start the distro.
  await runAsWslUserAct(distro, () => wslGatedAccess(toWindowsWslPath('/', distro), 'exact')).catch(
    () => {}
  )
}

/**
 * The host transcript path of a chat the user opened, and the start of its stopped WSL distro.
 * `waking` is null without a distro, so other chats open without an extra await.
 */
export function openNativeChatTranscript(
  sessionId: string,
  requestedPath: string | undefined
): { transcriptPath: string | undefined; waking: Promise<void> | null } {
  const statusRows = agentHookServer.getStatusSnapshot()
  const transcriptPath = nativeChatTranscriptPathOnExecutionHost(
    statusRows,
    sessionId,
    requestedPath
  )
  const distro = nativeChatTranscriptDistro(statusRows, sessionId, transcriptPath)
  return { transcriptPath, waking: distro ? wakeNativeChatTranscriptDistro(distro) : null }
}
