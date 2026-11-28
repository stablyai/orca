import { dirname, join } from 'node:path'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { buildAiVaultResumeCommand } from '../../../shared/ai-vault/resume/ai-vault-resume-command'
import { extractString } from '../../../shared/text/trimmed-string'
import { wslGatedReadFile } from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { generatedSessionTitle } from '../parsing/session-scanner-accumulator'
import { parseJsonObject } from '../parsing/session-json-object'
import { asRecord } from '../parsing/session-record-fields'
import { timestampMs } from '../parsing/session-record-time'
import { normalizeTitleText } from '../parsing/session-scanner-text-normalization'
import { isMissingTranscriptPathError } from '../discovery/session-path-absence'
import {
  readCursorChatMeta,
  wasCursorChatMetaRefused
} from '../scanners/cursor/session-scanner-cursor-chat-meta'
import { isCursorAcpSessionStorePath } from '../../../shared/ai-vault/session-display/cursor-acp-session-path'
import { devinSessionsIndexForSidecar } from '../scanners/devin/session-scanner-devin-db'
import { enrichDroidSessionFromSettings } from '../scanners/droid/session-scanner-droid-settings'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { SessionFileCandidate } from '../session-scanner-types'

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
    previous.branch === next.branch &&
    previous.createdAt === next.createdAt &&
    previous.updatedAt === next.updatedAt &&
    previous.resumeCommand === next.resumeCommand &&
    previous.model === next.model &&
    previous.totalTokens === next.totalTokens
  ) {
    return previous
  }
  return {
    ...previous,
    title: next.title,
    cwd: next.cwd,
    branch: next.branch,
    createdAt: next.createdAt,
    updatedAt: next.updatedAt,
    resumeCommand: next.resumeCommand,
    model: next.model,
    totalTokens: next.totalTokens
  }
}

export function sidecarEnrichesWithoutReparse(candidate: SessionFileCandidate): boolean {
  return (
    (candidate.agent === 'cursor' && !isCursorAcpSessionStorePath(candidate.file.path)) ||
    candidate.agent === 'devin' ||
    candidate.agent === 'droid' ||
    candidate.agent === 'mistral-vibe'
  )
}

/** The parser already applied the sidecar to the fold it built, so re-enriching after a full
 *  parse would only re-read the sidecar for nothing. */
export function sidecarAppliedByParser(candidate: SessionFileCandidate): boolean {
  return candidate.agent === 'mistral-vibe'
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
  if (candidate.agent === 'mistral-vibe') {
    return enrichVibeSessionFromMeta(candidate, foldSession, platform, signal)
  }
  if (candidate.agent === 'droid') {
    return enrichDroidSessionFromSettings(foldSession, candidate.file.path, signal)
  }
  if (candidate.agent !== 'cursor' || !foldSession) {
    return { session: foldSession, refused: false }
  }
  // Its meta.json is the row's only source, read by every parse.
  if (isCursorAcpSessionStorePath(candidate.file.path)) {
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

/** Vibe's meta.json carries title, cwd, branch, model, tokens and timestamps; merge them onto the
 *  saved fold so a sidecar-only change does not re-read the whole transcript. */
async function enrichVibeSessionFromMeta(
  candidate: SessionFileCandidate,
  foldSession: AiVaultSession | null,
  platform: NodeJS.Platform,
  signal?: AbortSignal
): Promise<SidecarEnrichment> {
  if (!foldSession) {
    return { session: foldSession, refused: false }
  }
  const content = await wslGatedReadFile(
    join(dirname(candidate.file.path), 'meta.json'),
    'utf-8',
    'scan',
    signal
  ).catch((error: unknown) => {
    if (isMissingTranscriptPathError(error)) {
      return null
    }
    return undefined
  })
  if (content === null) {
    return { session: foldSession, refused: false }
  }
  // Keep unreadable or corrupt sidecars unknown so the next scan retries enrichment.
  if (content === undefined) {
    return { session: foldSession, refused: true }
  }
  const meta = parseJsonObject(content)
  if (!meta) {
    return { session: foldSession, refused: true }
  }
  const cwd = extractString(asRecord(meta.environment)?.working_directory) ?? foldSession.cwd
  const startMs = timestampMs(meta.start_time)
  const endMs = timestampMs(meta.end_time)
  const tokens = asRecord(meta.stats)?.session_total_llm_tokens
  const merged: AiVaultSession = {
    ...foldSession,
    title: normalizeTitleText(extractString(meta.title) ?? '') || foldSession.title,
    cwd,
    branch: extractString(meta.git_branch) ?? foldSession.branch,
    createdAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : foldSession.createdAt,
    updatedAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : foldSession.updatedAt,
    model: extractString(asRecord(meta.config)?.active_model) ?? foldSession.model,
    totalTokens:
      typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : foldSession.totalTokens
  }
  return {
    session:
      cwd === foldSession.cwd
        ? merged
        : {
            ...merged,
            resumeCommand: buildAiVaultResumeCommand({
              agent: merged.agent,
              sessionId: merged.sessionId,
              resumeFilePath: merged.filePath,
              cwd,
              platform
            })
          },
    refused: false
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
