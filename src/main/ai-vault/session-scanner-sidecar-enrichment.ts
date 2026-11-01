import type { AiVaultSession } from '../../shared/ai-vault-types'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
import { generatedSessionTitle } from './session-scanner-accumulator'
import { readCursorChatMeta, wasCursorChatMetaRefused } from './session-scanner-cursor-chat-meta'
import { devinSessionsIndexForSidecar } from './session-scanner-devin-db'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { SessionFileCandidate } from './session-scanner-types'

/** Reapply sibling metadata to the transcript fold so rewritten sidecars replace earlier enrichment. */

export type SidecarEnrichment = {
  session: AiVaultSession | null
  /** Keep unreadable sidecars unknown so later scans retry. */
  refused: boolean
}

// Re-enrichment changes only these fields; retain other cached metadata and no-op identity.
export function reuseUnchangedSidecarSession(
  previous: AiVaultSession | null,
  next: AiVaultSession | null
): AiVaultSession | null {
  if (!previous || !next) {
    return next
  }
  if (
    previous.title === next.title &&
    previous.cwd === next.cwd &&
    previous.createdAt === next.createdAt &&
    previous.updatedAt === next.updatedAt &&
    previous.resumeCommand === next.resumeCommand &&
    previous.model === next.model
  ) {
    return previous
  }
  return {
    ...previous,
    title: next.title,
    cwd: next.cwd,
    createdAt: next.createdAt,
    updatedAt: next.updatedAt,
    resumeCommand: next.resumeCommand,
    model: next.model
  }
}

export function sidecarEnrichesWithoutReparse(candidate: SessionFileCandidate): boolean {
  return candidate.agent === 'cursor' || candidate.agent === 'devin'
}

export async function enrichSessionFromSidecar(
  candidate: SessionFileCandidate,
  foldSession: AiVaultSession | null,
  platform: NodeJS.Platform,
  signal?: AbortSignal
): Promise<SidecarEnrichment> {
  if (candidate.agent === 'devin') {
    return enrichDevinSessionFromDb(candidate.file.sidecar, foldSession, platform)
  }
  if (candidate.agent !== 'cursor' || !foldSession) {
    return { session: foldSession, refused: false }
  }
  const meta = await readCursorChatMeta(candidate.file.path, signal)
  if (!meta) {
    return {
      session: foldSession,
      refused: wasCursorChatMetaRefused(candidate.file.path)
    }
  }
  return {
    session: mergeCursorChatMeta(foldSession, meta, platform),
    refused: false
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

/** Devin’s shared index also determines membership: hidden rows suppress their sessions. */
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
    // Keep unreadable sidecars unknown so the next scan retries enrichment.
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
