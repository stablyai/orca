// Desktop host surface for AI Vault resume (U5): re-validate a client-echoed
// entry against the desktop's OWN fresh multi-host discovery, then either return
// the discovered session for a spawn (pty.ts) or assemble the copyable command
// string. Split out of ai-vault.ts so the scan orchestration and the resume
// surface stay independently sized. The discovery function is injected so this
// module never imports the scan orchestration (no cycle).

import { ipcMain } from 'electron'
import {
  findVaultResumeSession,
  resolveRevalidatedVaultResumeDetails,
  resolveVaultResumeCopyCommand,
  type VaultResumeAssemblySettings,
  type VaultResumeCopyResult,
  type VaultResumeDetailsResult,
  type VaultResumeSession
} from '../agent-launch/agent-launch-vault-resume'
import type { AgentLaunchVaultResumeEntry } from '../../shared/agent-launch-spawn-request'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { parseExecutionHostId } from '../../shared/execution-host'
import { getHostAgentSessionRecordStore } from '../agent-launch/agent-session-record-store-host'
import {
  applyAiVaultResumePreparation,
  type AiVaultSessionResumePreparation
} from '../../shared/ai-vault-resume-preparation'

// Why: force a fresh scan scoped to the entry's host so a deleted session cannot
// replay from stale cache; the high limit surfaces an older target past the
// default recency cap. Resume/copy are user-initiated, not a hot path.
const VAULT_RESUME_REVALIDATION_LIMIT = 2000

export type DiscoverAiVaultSessions = (args: AiVaultListArgs) => Promise<AiVaultListResult>
export type ResolveRuntimeAiVaultResumeDetails = (
  environmentId: string,
  entry: AgentLaunchVaultResumeEntry
) => Promise<VaultResumeDetailsResult>

async function discoverForEntry(
  entry: AgentLaunchVaultResumeEntry,
  discover: DiscoverAiVaultSessions
): Promise<AiVaultListResult> {
  return discover({
    executionHostScope: entry.executionHostId,
    limit: VAULT_RESUME_REVALIDATION_LIMIT,
    force: true
  })
}

// Re-validate a client-echoed entry against the desktop's OWN discovery, scoped
// to the entry's host (local/ssh/runtime) so it matches what the picker showed.
// Returns the host-discovered session (authoritative filePath et al.) or null.
export async function revalidateAiVaultResumeEntry(
  entry: AgentLaunchVaultResumeEntry,
  discover: DiscoverAiVaultSessions,
  // The entry echoes identity only, so the Codex account repin cannot ride it
  // over from the client — the host that rebuilds the command applies it here.
  prepare?: AiVaultSessionResumePreparation
): Promise<VaultResumeSession | null> {
  const discovered = await discoverForEntry(entry, discover)
  const session = findVaultResumeSession(entry, discovered.sessions)
  return session ? applyAiVaultResumePreparation(session, prepare) : null
}

// Desktop 'copy' vault-resume: re-validate + assemble the copyable command. The
// command is a pure clipboard artifact; a session the host did not discover is an
// in-band invalid_launch_snapshot, never a substituted current command.
async function resolveAiVaultResumeCopyCommand(
  entry: AgentLaunchVaultResumeEntry,
  discover: DiscoverAiVaultSessions,
  settings: VaultResumeAssemblySettings | undefined,
  prepare?: AiVaultSessionResumePreparation,
  targetPlatform?: NodeJS.Platform
): Promise<VaultResumeCopyResult> {
  const session = await revalidateAiVaultResumeEntry(entry, discover, prepare)
  if (!session) {
    return { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
  }
  return resolveVaultResumeCopyCommand({
    entry,
    sessions: [session],
    // The client names the PASTE target's platform (its WSL/SSH workspace reads
    // as linux); only quoting depends on it, and the host never runs this string.
    hostPlatform: targetPlatform ?? process.platform,
    settings
  })
}

async function resolveAiVaultResumeDetails(
  entry: AgentLaunchVaultResumeEntry,
  discover: DiscoverAiVaultSessions,
  resolveRuntimeDetails?: ResolveRuntimeAiVaultResumeDetails
): Promise<VaultResumeDetailsResult> {
  const parsedHost = parseExecutionHostId(entry.executionHostId)
  if (parsedHost?.kind === 'runtime') {
    return resolveRuntimeDetails
      ? resolveRuntimeDetails(parsedHost.environmentId, entry)
      : { status: 'unavailable' }
  }
  const session = await revalidateAiVaultResumeEntry(entry, discover)
  return session
    ? resolveRevalidatedVaultResumeDetails({
        session,
        sessionRecordStore: getHostAgentSessionRecordStore()
      })
    : { status: 'unavailable' }
}

// Register the host-owned copy-command IPC. The renderer echoes a discovered
// entry's identity and the host re-validates + assembles the string, so the
// client no longer builds the launch itself.
export function registerAiVaultResumeCommandHandler(
  discover: DiscoverAiVaultSessions,
  options?: {
    getVaultResumeSettings?: () => VaultResumeAssemblySettings | undefined
    resolveRuntimeAiVaultResumeDetails?: ResolveRuntimeAiVaultResumeDetails
    prepareSessionResume?: AiVaultSessionResumePreparation
  }
): void {
  ipcMain.handle(
    'aiVault:resumeCommand',
    (
      _event,
      entry: AgentLaunchVaultResumeEntry,
      targetPlatform?: NodeJS.Platform
    ): Promise<VaultResumeCopyResult> =>
      resolveAiVaultResumeCopyCommand(
        entry,
        discover,
        options?.getVaultResumeSettings?.(),
        options?.prepareSessionResume,
        targetPlatform
      )
  )
  ipcMain.handle(
    'aiVault:resumeDetails',
    (_event, entry: AgentLaunchVaultResumeEntry): Promise<VaultResumeDetailsResult> =>
      resolveAiVaultResumeDetails(entry, discover, options?.resolveRuntimeAiVaultResumeDetails)
  )
}
