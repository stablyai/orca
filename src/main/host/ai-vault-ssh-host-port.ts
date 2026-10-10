import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'

export type AiVaultSshTranscriptProbe = 'present' | 'missing' | 'unverifiable'

/**
 * Why a port: the runtime also boots headless where Electron is unavailable, but the SSH relay
 * sessions live in Electron-side modules. The SSH layer installs this when it registers; until
 * then (or in a process without SSH) every SSH scope reads as not connected.
 */
export type AiVaultSshHostPort = {
  isActiveTarget: (targetId: string) => boolean
  list: (
    targetId: string,
    args: AiVaultListArgs | undefined,
    signal?: AbortSignal
  ) => Promise<AiVaultListResult>
  probeWslTranscript: (targetId: string, filePath: string) => Promise<AiVaultSshTranscriptProbe>
}

let installedPort: AiVaultSshHostPort | null = null

export function installAiVaultSshHostPort(port: AiVaultSshHostPort | null): void {
  installedPort = port
}

const NOT_CONNECTED_MESSAGE =
  'That SSH host is not connected on the Orca host. Reconnect it there and try again.'

/** True only for an SSH target this process currently holds a live relay session for. */
export function isActiveSshAiVaultTarget(targetId: string): boolean {
  return installedPort?.isActiveTarget(targetId) ?? false
}

export async function listSshHostScopeAiVaultSessions(
  targetId: string,
  args: AiVaultListArgs | undefined,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  if (!installedPort) {
    throw new Error(NOT_CONNECTED_MESSAGE)
  }
  return installedPort.list(targetId, args, signal)
}

export async function probeWslTranscriptOnSshHost(
  targetId: string,
  filePath: string
): Promise<AiVaultSshTranscriptProbe> {
  if (!installedPort) {
    throw new Error(NOT_CONNECTED_MESSAGE)
  }
  return installedPort.probeWslTranscript(targetId, filePath)
}
