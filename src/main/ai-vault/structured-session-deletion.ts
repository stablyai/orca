import { lstat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type {
  AiVaultDeleteSessionResult,
  AiVaultSessionDeleteAllowedResult
} from '../../shared/ai-vault-session-deletion'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { claudeSessionIdForOrcaSession } from '../claude/claude-session-identity'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentSessionStoreExclusiveInspection } from '../runtime/agent-session-store-transaction-queue'

export type StructuredAiVaultDeletionDeps = {
  /** Start the structured host if it is not running, so an absent host is a real answer. */
  ensureStructuredSessionOwnership: () => Promise<void>
}

type OwnedRefusal = Extract<AiVaultDeleteSessionResult, { outcome: 'rejected' }>

const unknownOwnership: OwnedRefusal = {
  outcome: 'rejected',
  agent: 'claude',
  reason: 'structured-session-ownership-unknown'
}

/**
 * Run a native Claude removal only if no structured session owns its transcript,
 * with the decision and the removal holding the same lock a reservation takes.
 *
 * Why the lock rather than a check followed by a delete: acquisition can land
 * between the two, and the window is not theoretical — the reservation is
 * written before the provider is spawned. Deciding inside the store's own
 * transaction boundary is what makes the answer still true when `remove` runs.
 *
 * Absence is never permission. A missing host, an unreadable catalogue, or a
 * transcript reachable under aliases this check cannot enumerate all refuse as
 * `structured-session-ownership-unknown` before anything is removed.
 */
export async function deleteUnownedClaudeAiVaultSession(
  validation: AiVaultSessionDeleteAllowedResult,
  deps: StructuredAiVaultDeletionDeps,
  remove: () => Promise<AiVaultDeleteSessionResult>
): Promise<AiVaultDeleteSessionResult> {
  try {
    await deps.ensureStructuredSessionOwnership()
  } catch {
    return unknownOwnership
  }
  const store = getStructuredAgentSessionHost()?.deps.store
  if (!store) {
    return unknownOwnership
  }

  const transcriptId = claudeTranscriptIdentity(validation.resolvedPath)
  if (!transcriptId) {
    return unknownOwnership
  }

  try {
    return await store.withExclusiveHistoryInspection(async (inspection) => {
      const owner = findClaudeTranscriptOwner(inspection, transcriptId)
      if (owner === 'unknown') {
        return unknownOwnership
      }
      if (owner) {
        return {
          outcome: 'rejected',
          agent: 'claude',
          reason: 'structured-session-owned',
          structuredSession: { sessionId: owner.sessionId, workspaceId: owner.workspaceId }
        }
      }
      if (await hasUnmappableAliases(validation.resolvedPath)) {
        return unknownOwnership
      }
      return await remove()
    })
  } catch {
    // A refresh that could not establish the catalogue (corrupt store, legacy
    // schema, lock failure) reaches here before `remove` is ever called, so
    // nothing has been touched.
    return unknownOwnership
  }
}

/**
 * A second name for this inode means the id in the path we checked is not the
 * only id that reaches it, so a clean ownership answer for this path is not an
 * answer for the file. Refuse instead of enumerating aliases.
 *
 * A missing path has no inode left to alias. Windows WSL paths also proceed
 * because their 9P stat is unreliable and deletion is validated inside the
 * distro. Every other inspection failure leaves ownership unknown.
 */
async function hasUnmappableAliases(resolvedPath: string): Promise<boolean> {
  try {
    return (await lstat(resolvedPath)).nlink > 1
  } catch (error) {
    if (
      isENOENT(error) ||
      (process.platform === 'win32' && parseWslUncPath(resolvedPath) !== null)
    ) {
      return false
    }
    return true
  }
}

/** The provider session id a Claude transcript path names, or null if it names none. */
function claudeTranscriptIdentity(resolvedPath: string): string | null {
  const stem = basename(resolvedPath, extname(resolvedPath))
  return stem && stem !== '.' && stem !== '..' ? stem : null
}

type ClaudeOwner = { sessionId: string; workspaceId: string }

/**
 * `null` = provably unowned, `'unknown'` = not provably anything, otherwise the owner.
 *
 * Matches every link in each record's handle chain, not only its head, because a
 * resumed session keeps writing the transcript its earlier links name. A Claude
 * record with no chain yet is matched on its deterministic initial identity, so a
 * reservation that has not been acquired still protects its transcript.
 */
function findClaudeTranscriptOwner(
  inspection: AgentSessionStoreExclusiveInspection,
  transcriptId: string
): ClaudeOwner | null | 'unknown' {
  for (const record of inspection.records) {
    if (record.provider !== 'claude') {
      continue
    }
    if (claudeRecordIdentities(record).includes(transcriptId)) {
      return { sessionId: record.sessionId, workspaceId: record.location.workspaceId }
    }
  }
  // No match is only an answer when the catalogue we searched was the whole one.
  return inspection.complete ? null : 'unknown'
}

function claudeRecordIdentities(
  record: AgentSessionStoreExclusiveInspection['records'][number]
): string[] {
  const chain = record.providerHandleChain.flatMap((link) =>
    link.handle.provider === 'claude' ? [link.handle.sessionId] : []
  )
  // Deliberately additive rather than a fallback: a record can carry links and
  // still have its initial transcript on disk from before the first resume.
  return [...chain, claudeSessionIdForOrcaSession(record.sessionId)]
}
