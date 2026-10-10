import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { requestedAiVaultSessionDepth } from '../../shared/ai-vault-session-depth'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { scanHostLegWithCache } from '../ipc/ai-vault-host-leg-cache'
import { getActiveSshAiVaultHostInfo, getActiveSshAiVaultHostInfos } from '../ipc/ssh'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { AiVaultSshHostPort, AiVaultSshTranscriptProbe } from '../host/ai-vault-ssh-host-port'
import { aiVaultListCacheKey } from './ai-vault-list-cache-key'
import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import { scanSshAiVaultSessions } from './ssh-session-list'

/** True only for an SSH target this process currently holds a live relay session for. */
export function isActiveSshAiVaultTarget(targetId: string): boolean {
  try {
    return getActiveSshAiVaultHostInfos().some((info) => info.targetId === targetId)
  } catch {
    return false
  }
}

function assertActiveSshAiVaultTarget(targetId: string): void {
  if (!isActiveSshAiVaultTarget(targetId)) {
    // Why: never scan a target the client merely named; only hosts this process is connected to.
    throw new Error(
      'That SSH host is not connected on the Orca host. Reconnect it there and try again.'
    )
  }
}

/** Runtime-RPC entry for a single SSH host scope; mirrors the desktop IPC's host leg. */
export async function listSshHostScopeAiVaultSessions(
  targetId: string,
  args: AiVaultListArgs | undefined,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  assertActiveSshAiVaultTarget(targetId)
  return scanHostLegWithCache({
    cacheKey: aiVaultListCacheKey(args, toSshExecutionHostId(targetId)),
    depth: requestedAiVaultSessionDepth(args),
    scopePaths: args?.scopePaths ?? [],
    force: args?.force === true,
    scan: () => scanSshAiVaultSessions(targetId, args, { signal })
  })
}

/**
 * Does the transcript behind a host-local WSL UNC path also exist on this SSH host?
 * Only a verified stat of the translated Linux path says `missing`; a dropped
 * connection or a non-POSIX host stays `unverifiable`, never evidence of absence.
 */
export async function probeWslTranscriptOnSshHost(
  targetId: string,
  filePath: string
): Promise<AiVaultSshTranscriptProbe> {
  assertActiveSshAiVaultTarget(targetId)
  const wsl = parseWslUncPath(filePath)
  const hostInfo = getActiveSshAiVaultHostInfo(targetId)
  const provider = getSshFilesystemProvider(targetId)
  if (!wsl || wsl.linuxPath === '/' || !hostInfo || !provider) {
    return 'unverifiable'
  }
  if (hostInfo.hostPlatform.pathFlavor !== 'posix') {
    return 'unverifiable'
  }
  try {
    const stat = await provider.stat(wsl.linuxPath)
    return stat.type === 'directory' ? 'missing' : 'present'
  } catch (error) {
    return isMissingRemoteSessionPathError(error) ? 'missing' : 'unverifiable'
  }
}

/** The Electron-side implementation the runtime reaches through the host port. */
export function createAiVaultSshHostPort(): AiVaultSshHostPort {
  return {
    isActiveTarget: isActiveSshAiVaultTarget,
    list: listSshHostScopeAiVaultSessions,
    probeWslTranscript: probeWslTranscriptOnSshHost
  }
}
