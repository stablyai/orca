import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import { buildMobileWebSourceControlDiffPage } from '../../../src/shared/mobile-web/source-control-diff-page'
import {
  MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS,
  MobileWebSourceControlDiffResultSchema,
  MobileWebSourceControlStatusEntrySchema,
  MobileWebSourceControlStatusResultSchema,
  type MobileWebSourceControlDiffPayload,
  type MobileWebSourceControlDiffResult,
  type MobileWebSourceControlStatusEntry,
  type MobileWebSourceControlStatusResult
} from '../../../src/shared/mobile-web/source-control-operation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export function sanitizeMobileWebSourceControlStatus(
  result: unknown,
  workspaceId: string,
  limit: number
): MobileWebSourceControlStatusResult {
  if (!isRecord(result) || !Array.isArray(result.entries)) {
    throw new MobileWebBrokerError('host_error')
  }
  const entries = result.entries.slice(0, limit).flatMap((candidate) => {
    const entry = sanitizeStatusEntry(candidate)
    return entry ? [entry] : []
  })
  const reportedTotal = safeNonnegativeInteger(result.statusLength)
  const totalCount = Math.max(entries.length, reportedTotal ?? result.entries.length)
  const branch = boundedNonemptyString(result.branch, 240)
  const head =
    typeof result.head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result.head)
      ? result.head
      : undefined

  return MobileWebSourceControlStatusResultSchema.parse({
    workspaceId,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    conflictOperation: readConflictOperation(result.conflictOperation),
    entries,
    totalCount,
    truncated:
      result.didHitLimit === true ||
      result.entries.length > limit ||
      entries.length < Math.min(result.entries.length, limit) ||
      totalCount > entries.length
  })
}

export function sanitizeMobileWebSourceControlDiff(
  result: unknown,
  payload: MobileWebSourceControlDiffPayload
): MobileWebSourceControlDiffResult {
  const identity = {
    workspaceId: payload.workspaceId,
    relativePath: payload.relativePath,
    area: payload.area
  }
  if (!isRecord(result)) {
    throw new MobileWebBrokerError('host_error')
  }
  if (result.kind === 'binary') {
    return MobileWebSourceControlDiffResultSchema.parse({ ...identity, kind: 'binary' })
  }
  if (result.kind === 'too-large' || hostLimitedDiff(result)) {
    return MobileWebSourceControlDiffResultSchema.parse({
      ...identity,
      kind: 'too-large',
      reason: 'host-limit',
      ...(hostDiffCharacterCount(result) === undefined
        ? {}
        : { characterCount: hostDiffCharacterCount(result) })
    })
  }
  if (
    result.kind !== 'text' ||
    typeof result.originalContent !== 'string' ||
    typeof result.modifiedContent !== 'string'
  ) {
    throw new MobileWebBrokerError('host_error')
  }

  const characterCount = result.originalContent.length + result.modifiedContent.length
  const revision =
    characterCount > MOBILE_WEB_DIFF_INPUT_MAX_CHARACTERS
      ? '0'.repeat(64)
      : diffRevision(result.originalContent, result.modifiedContent)
  if (payload.expectedRevision && revision !== payload.expectedRevision) {
    throw new MobileWebBrokerError('conflict')
  }
  return MobileWebSourceControlDiffResultSchema.parse(
    buildMobileWebSourceControlDiffPage({
      ...identity,
      revision,
      originalContent: result.originalContent,
      modifiedContent: result.modifiedContent,
      offset: payload.offset,
      limit: payload.limit
    })
  )
}

function sanitizeStatusEntry(candidate: unknown): MobileWebSourceControlStatusEntry | null {
  if (!isRecord(candidate)) {
    return null
  }
  const parsed = MobileWebSourceControlStatusEntrySchema.safeParse({
    relativePath: candidate.path,
    ...(candidate.oldPath === undefined ? {} : { oldRelativePath: candidate.oldPath }),
    status: candidate.status,
    area: candidate.area,
    ...(candidate.conflictStatus === undefined ? {} : { conflictStatus: candidate.conflictStatus }),
    ...(safeNonnegativeInteger(candidate.added) === undefined ? {} : { added: candidate.added }),
    ...(safeNonnegativeInteger(candidate.removed) === undefined
      ? {}
      : { removed: candidate.removed })
  })
  return parsed.success ? parsed.data : null
}

function diffRevision(originalContent: string, modifiedContent: string): string {
  const digest = sha256.create()
  digest.update(new TextEncoder().encode(originalContent))
  digest.update(Uint8Array.of(0))
  digest.update(new TextEncoder().encode(modifiedContent))
  return Buffer.from(digest.digest()).toString('hex')
}

function hostLimitedDiff(result: Record<string, unknown>): boolean {
  return isRecord(result.largeDiffRenderLimit) && result.largeDiffRenderLimit.limited === true
}

function hostDiffCharacterCount(result: Record<string, unknown>): number | undefined {
  if (result.kind === 'too-large') {
    return (
      safeNonnegativeInteger(result.characterCount) ?? safeNonnegativeInteger(result.byteLength)
    )
  }
  return isRecord(result.largeDiffRenderLimit)
    ? safeNonnegativeInteger(result.largeDiffRenderLimit.characterCount)
    : undefined
}

function readConflictOperation(value: unknown): 'merge' | 'rebase' | 'cherry-pick' | 'unknown' {
  return value === 'merge' || value === 'rebase' || value === 'cherry-pick' ? value : 'unknown'
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function boundedNonemptyString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
