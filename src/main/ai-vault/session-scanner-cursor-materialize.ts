import {
  isAiVaultSessionResumableContent,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
import { buildAiVaultSessionId } from '../../shared/ai-vault-session-id'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { CursorSidecarEvidence } from './session-scanner-cursor-sidecar'
import type {
  CursorPhysicalGroup,
  CursorReconcileStats,
  ParsedCursorCandidate
} from './session-scanner-cursor-reconcile'

export function materializeCursorSession(args: {
  group: CursorPhysicalGroup
  executionHostId: ExecutionHostId
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
  commandOverride?: string | null
  stats: CursorReconcileStats
}): AiVaultSession | null {
  const sidecars = args.group.candidates.filter(
    (candidate): candidate is ParsedCursorCandidate & { sidecar: CursorSidecarEvidence } =>
      Boolean(candidate.sidecar)
  )
  const legacy = args.group.candidates.filter(
    (candidate): candidate is ParsedCursorCandidate & { legacy: AiVaultSession } =>
      Boolean(candidate.legacy)
  )
  if (sidecars.some((candidate) => candidate.sidecar.isSubagent)) {
    args.stats.suppressedSubagents++
    return null
  }
  const legacyWithContent = legacy.filter((candidate) =>
    isAiVaultSessionResumableContent(candidate.legacy)
  )
  if (
    !sidecars.some((candidate) => candidate.sidecar.hasConversation) &&
    legacyWithContent.length === 0
  ) {
    args.stats.falseOnlyGroups++
    return null
  }

  const sidecarSource = [...sidecars].sort(compareSidecars)[0]
  const legacySource = [...legacy].sort(compareLegacy)[0]
  if (sidecarSource && legacySource) {
    args.stats.reconciledCounterparts++
  }
  const strongCwd = selectStrongCwd(args.group.candidates, args.executionHostId, args.issues)
  const filePath = sidecarSource?.file.path ?? legacySource?.file.path
  if (!filePath) {
    return null
  }
  const modifiedAt = latestIso([
    sidecarSource?.sidecar.updatedAt,
    legacySource?.legacy.updatedAt,
    legacySource?.legacy.modifiedAt
  ])
  const transcriptFilePath = legacySource?.file.path ?? null

  return {
    id: buildAiVaultSessionId({
      executionHostId: args.executionHostId,
      agent: 'cursor',
      sessionId: args.group.sessionId,
      filePath,
      cursorStorageContextKey: args.group.storageContextKey,
      cursorBucketCollision: args.group.bucketCollision,
      cursorLegacyPathCollision: args.group.legacyPathCollision
    }),
    executionHostId: args.executionHostId,
    executionHostPlatform: args.platform,
    agent: 'cursor',
    sessionId: args.group.sessionId,
    title:
      sidecarSource?.sidecar.title ??
      legacySource?.legacy.title ??
      `Cursor ${args.group.sessionId.slice(0, 8)}`,
    cwd: strongCwd,
    branch: legacySource?.legacy.branch ?? null,
    model: null,
    filePath,
    codexHome: null,
    createdAt: earliestIso([sidecarSource?.sidecar.createdAt, legacySource?.legacy.createdAt]),
    updatedAt: latestNullableIso([
      sidecarSource?.sidecar.updatedAt,
      legacySource?.legacy.updatedAt
    ]),
    modifiedAt,
    messageCount: legacySource?.legacy.messageCount ?? 0,
    hasConversation: sidecars.some((candidate) => candidate.sidecar.hasConversation),
    transcriptFilePath,
    totalTokens: legacySource?.legacy.totalTokens ?? 0,
    previewMessages: legacySource?.legacy.previewMessages ?? [],
    ...(legacySource?.legacy.lastUserPrompt
      ? { lastUserPrompt: legacySource.legacy.lastUserPrompt }
      : {}),
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: buildAiVaultResumeCommand({
      agent: 'cursor',
      sessionId: args.group.sessionId,
      cwd: strongCwd,
      platform: args.platform,
      commandOverride: args.commandOverride
    }),
    subagent: null
  }
}

function selectStrongCwd(
  candidates: readonly ParsedCursorCandidate[],
  executionHostId: ExecutionHostId,
  issues: AiVaultScanIssue[]
): string | null {
  const scope = candidates
    .map((candidate) => candidate.cwdEvidence)
    .find((evidence) => evidence?.kind === 'scope-bucket' && evidence.cwd)?.cwd
  const sidecar = candidates
    .map((candidate) => candidate.sidecar?.cwdEvidence)
    .find((evidence) => evidence?.kind === 'sidecar-bucket-match' && evidence.cwd)?.cwd
  if (scope && sidecar && scope !== sidecar) {
    issues.push({
      executionHostId,
      agent: 'cursor',
      path: candidates[0].file.path,
      message: 'Cursor scope path conflicts with recorded session metadata; using scope evidence.'
    })
  }
  return scope ?? sidecar ?? null
}

function compareSidecars(
  left: ParsedCursorCandidate & { sidecar: CursorSidecarEvidence },
  right: ParsedCursorCandidate & { sidecar: CursorSidecarEvidence }
): number {
  const scopeDelta =
    Number(right.cwdEvidence?.kind === 'scope-bucket') -
    Number(left.cwdEvidence?.kind === 'scope-bucket')
  return (
    scopeDelta ||
    Date.parse(right.sidecar.updatedAt) - Date.parse(left.sidecar.updatedAt) ||
    right.file.mtimeMs - left.file.mtimeMs ||
    left.file.path.localeCompare(right.file.path)
  )
}

function compareLegacy(
  left: ParsedCursorCandidate & { legacy: AiVaultSession },
  right: ParsedCursorCandidate & { legacy: AiVaultSession }
): number {
  return (
    right.legacy.messageCount - left.legacy.messageCount ||
    right.file.mtimeMs - left.file.mtimeMs ||
    left.file.path.localeCompare(right.file.path)
  )
}

function latestIso(values: (string | null | undefined)[]): string {
  return latestNullableIso(values) ?? new Date(0).toISOString()
}

function latestNullableIso(values: (string | null | undefined)[]): string | null {
  const valid = values
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort((left, right) => Date.parse(right) - Date.parse(left))
  return valid[0] ?? null
}

function earliestIso(values: (string | null | undefined)[]): string | null {
  const valid = values
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
  return valid[0] ?? null
}
