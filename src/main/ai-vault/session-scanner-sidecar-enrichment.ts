import type { AiVaultSession } from '../../shared/ai-vault-types'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
import { generatedSessionTitle } from './session-scanner-accumulator'
import { readCursorChatMeta, wasCursorChatMetaRefused } from './session-scanner-cursor-chat-meta'
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
  return candidate.agent === 'cursor'
}

export async function enrichSessionFromSidecar(
  candidate: SessionFileCandidate,
  foldSession: AiVaultSession | null,
  platform: NodeJS.Platform
): Promise<SidecarEnrichment> {
  if (candidate.agent !== 'cursor' || !foldSession) {
    return { session: foldSession, refused: false }
  }
  const meta = await readCursorChatMeta(candidate.file.path)
  if (!meta) {
    return { session: foldSession, refused: wasCursorChatMetaRefused(candidate.file.path) }
  }
  return { session: mergeCursorChatMeta(foldSession, meta, platform), refused: false }
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
