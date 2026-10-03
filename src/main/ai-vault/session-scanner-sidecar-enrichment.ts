import type { AiVaultSession } from '../../shared/ai-vault-types'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
import { generatedSessionTitle } from './session-scanner-accumulator'
import { readCursorChatMeta, wasCursorChatMetaRefused } from './session-scanner-cursor-chat-meta'
import { resolveCursorTranscriptCwd } from './session-scanner-cursor-project-cwd'
import { devinSessionsIndexForSidecar } from './session-scanner-devin-db'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { SessionFileCandidate } from './session-scanner-types'

/**
 * Merges an agent's sibling file onto the session its transcript alone
 * produced. Kept out of the fold and applied here so it is a pure function of
 * (fold result, sibling): re-running it starts from what the transcript said,
 * never from a previous merge, so a rewritten sibling replaces the fields it
 * supplied last time instead of losing to them.
 *
 * The reuse-time counterpart of session-scanner-codex-cached-title.ts, for
 * agents whose sibling the transcript key cannot see.
 */

export type SidecarEnrichment = {
  session: AiVaultSession | null
  /** The sibling could not be read; the caller records the observation as unknown. */
  refused: boolean
}

/** True when the sibling only adds metadata, so a change to it needs no re-parse. */
export function sidecarEnrichesWithoutReparse(candidate: SessionFileCandidate): boolean {
  return candidate.agent === 'cursor' || candidate.agent === 'devin'
}

export async function enrichSessionFromSidecar(
  candidate: SessionFileCandidate,
  foldSession: AiVaultSession | null,
  platform: NodeJS.Platform
): Promise<SidecarEnrichment> {
  if (candidate.agent === 'devin') {
    return enrichDevinSessionFromDb(candidate.file.sidecar, foldSession, platform)
  }
  if (candidate.agent !== 'cursor' || !foldSession) {
    return { session: foldSession, refused: false }
  }
  const meta = await readCursorChatMeta(candidate.file.path)
  if (!meta) {
    const refused = wasCursorChatMetaRefused(candidate.file.path)
    if (refused) {
      return { session: foldSession, refused: true }
    }
    // Attribute legacy transcripts without a chats meta.json to their project cwd
    const legacyCwd = await resolveCursorTranscriptCwd(candidate.file.path)
    if (legacyCwd && !foldSession.cwd) {
      return {
        session: applyCursorLegacyCwd(foldSession, legacyCwd, platform),
        refused: false
      }
    }
    return { session: foldSession, refused: false }
  }
  const enriched = mergeCursorChatMeta(foldSession, meta, platform)
  if (!enriched.cwd) {
    const legacyCwd = await resolveCursorTranscriptCwd(candidate.file.path)
    if (legacyCwd) {
      return {
        session: applyCursorLegacyCwd(enriched, legacyCwd, platform),
        refused: false
      }
    }
  }
  return {
    session: enriched,
    refused: false
  }
}

function applyCursorLegacyCwd(
  session: AiVaultSession,
  cwd: string,
  platform: NodeJS.Platform
): AiVaultSession {
  return {
    ...session,
    cwd,
    resumeCommand: buildAiVaultResumeCommand({
      agent: session.agent,
      sessionId: session.sessionId,
      resumeFilePath: session.filePath,
      cwd,
      platform
    })
  }
}

/** Fills only what the transcript never recorded; its own records always win. */
export function mergeCursorChatMeta(
  session: AiVaultSession,
  meta: {
    title: string | null
    cwd: string | null
    createdAt: string | null
    updatedAt: string | null
  },
  platform: NodeJS.Platform
): AiVaultSession {
  // A generated title means the fold found none, so the sibling's may stand in.
  const named = session.title !== generatedSessionTitle(session.agent, session.sessionId)
  const cwd = session.cwd ?? meta.cwd
  const merged: AiVaultSession = {
    ...session,
    title: named ? session.title : (meta.title ?? session.title),
    cwd,
    createdAt: session.createdAt ?? meta.createdAt,
    updatedAt: session.updatedAt ?? meta.updatedAt
  }
  if (cwd === session.cwd) {
    return merged
  }
  // The resume command embeds the cwd, so it has to be rebuilt with it.
  return {
    ...merged,
    resumeCommand: buildAiVaultResumeCommand({
      agent: merged.agent,
      sessionId: merged.sessionId,
      resumeFilePath: merged.filePath,
      cwd,
      platform
    })
  }
}

/**
 * Merge the Devin sessions.db row onto the transcript's session. Devin's
 * sibling is one shared index for the whole transcripts dir rather than a
 * per-session file, so this also decides membership: a row the user hid in
 * Devin's UI drops the session from the listing entirely.
 */
function enrichDevinSessionFromDb(
  sidecar: SessionSidecarObservation | undefined,
  foldSession: AiVaultSession | null,
  platform: NodeJS.Platform
): SidecarEnrichment {
  if (!foldSession) {
    return { session: foldSession, refused: false }
  }
  const { index, unreadable } = devinSessionsIndexForSidecar(sidecar)
  if (!index) {
    // An observed-but-unreadable db must not settle as "no enrichment": the
    // refusal keeps the sidecar unknown so the next scan retries the merge.
    return { session: foldSession, refused: unreadable }
  }
  const row = index.get(foldSession.sessionId)
  if (!row) {
    return { session: foldSession, refused: false }
  }
  if (row.hidden) {
    return { session: null, refused: false }
  }
  const merged = mergeCursorChatMeta(
    foldSession,
    {
      title: row.title,
      cwd: row.workingDirectory,
      createdAt: row.createdAt,
      updatedAt: row.lastActivityAt
    },
    platform
  )
  return {
    session:
      foldSession.model === null && row.model !== null ? { ...merged, model: row.model } : merged,
    refused: false
  }
}
