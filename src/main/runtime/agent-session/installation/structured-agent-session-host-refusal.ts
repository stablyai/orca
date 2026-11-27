import {
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { hasPersistedStructuredAgentSessionDatabaseFile } from '../records/persisted-agent-session-database-file'

let installRefusal: AgentSessionRefusalError | null = null

export function structuredAgentSessionHostRefusal(): AgentSessionRefusalError | null {
  return installRefusal
}

function isStructuredAgentSessionHostRefusal(error: unknown): boolean {
  const refusal = installRefusal
  return (
    refusal !== null &&
    isAgentSessionRefusalError(error) &&
    error.refusal.code === refusal.refusal.code &&
    error.refusal.message === refusal.refusal.message
  )
}

/** Non-chat work may proceed without a refused host; other installation errors still throw. */
export async function ensureStructuredAgentSessionHostUnlessRefused(
  ensureHost: () => Promise<unknown>
): Promise<void> {
  try {
    await ensureHost()
  } catch (error) {
    if (!isStructuredAgentSessionHostRefusal(error)) {
      throw error
    }
  }
}

/** Skip booting the chat journal host for ownership lookups when no chat store exists yet. */
export async function ensurePersistedStructuredAgentSessionHostUnlessRefused(
  ensureHost: () => Promise<unknown>
): Promise<void> {
  if (
    !getStructuredAgentSessionHost() &&
    !(await hasPersistedStructuredAgentSessionDatabaseFile(getProfileUserDataPath()))
  ) {
    return
  }
  await ensureStructuredAgentSessionHostUnlessRefused(ensureHost)
}

/** Chat-host setup is bookkeeping for a terminal resume; an existing owner is checked afterward. */
export async function tryEnsureStructuredAgentSessionHostForResume(
  ensureHost: () => Promise<unknown>
): Promise<void> {
  try {
    await ensureStructuredAgentSessionHostUnlessRefused(ensureHost)
  } catch (error) {
    const code = isAgentSessionRefusalError(error)
      ? error.refusal.code
      : error instanceof Error
        ? error.message
        : null
    if (code === 'agent_session_conflict' || code === 'agent_session_ownership_unknown') {
      throw error
    }
    console.warn('[ai-vault] native chat host setup failed during terminal resume:', error)
  }
}

/** A journal-open refusal clears on successful installation; the next call retries. */
export function recordStructuredAgentSessionHostInstallRefusal(
  refusal: AgentSessionRefusalError | null
): void {
  installRefusal = refusal
}
