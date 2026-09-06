import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MobileWebProviderReviewDiffPayloadSchema,
  MobileWebProviderReviewDiffResultSchema,
  type MobileWebProviderReviewDiffPayload,
  type MobileWebProviderReviewDiffResult
} from '../../../src/shared/mobile-web/provider-review-diff-contract'
import {
  buildMobileWebProviderReviewContentDiffPage,
  buildMobileWebProviderReviewPatchDiffPage
} from '../../../src/shared/mobile-web/provider-review-diff-page'
import type { MobileWebProviderReviewFile } from '../../../src/shared/mobile-web/provider-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-hosted-review-service'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  assertCurrentRepositoryIdentity,
  readHostedReviewSummary,
  readProviderDetails
} from './mobile-web-provider-review-state'
import { sanitizeMobileWebProviderReviewDetails } from './mobile-web-provider-review-sanitizer'
import { githubProviderReviewTarget } from './mobile-web-provider-review-targets'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebProviderReviewDiff(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
): Promise<MobileWebProviderReviewDiffResult> {
  const payload = MobileWebProviderReviewDiffPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  await assertCurrentRepositoryIdentity(client, hostWorkspaceId, payload)
  const repo = mobileRepoSelectorFromWorktreeId(hostWorkspaceId)
  const summary = await readHostedReviewSummary(client, repo, payload)
  if (
    !summary ||
    summary.provider !== payload.provider ||
    summary.number !== payload.reviewNumber ||
    (payload.provider !== 'github' && payload.provider !== 'gitlab')
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  const details = await readProviderDetails(client, repo, summary)
  const review = sanitizeMobileWebProviderReviewDetails(summary, details)
  const file = review.files.find((candidate) => candidate.path === payload.path)
  if (review.detailsState !== 'loaded' || review.headSha !== payload.expectedReviewHead || !file) {
    throw new MobileWebBrokerError('conflict')
  }

  const result =
    payload.provider === 'github'
      ? await readGitHubReviewDiff({ client, repo, payload, details, file })
      : readGitLabReviewDiff(payload, details, file)
  assertRequestedPageIdentity(payload, result)
  return MobileWebProviderReviewDiffResultSchema.parse(result)
}

async function readGitHubReviewDiff(args: {
  client: RpcClient
  repo: string
  payload: MobileWebProviderReviewDiffPayload
  details: unknown
  file: MobileWebProviderReviewFile
}): Promise<MobileWebProviderReviewDiffResult> {
  const position = reviewPosition(args.details)
  if (!position || position.headSha !== args.payload.expectedReviewHead) {
    throw new MobileWebBrokerError('conflict')
  }
  if (args.file.isBinary) {
    return binaryResult(args.payload)
  }
  const response = await args.client.sendRequest('github.prFileContents', {
    repo: args.repo,
    prNumber: args.payload.reviewNumber,
    path: args.file.path,
    ...(args.file.oldPath ? { oldPath: args.file.oldPath } : {}),
    status: args.file.status,
    headSha: position.headSha,
    baseSha: position.baseSha,
    ...githubProviderReviewTarget(args.details)
  })
  if (!response.ok || !isRecord(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  if (response.result.originalIsBinary === true || response.result.modifiedIsBinary === true) {
    return binaryResult(args.payload)
  }
  if (response.result.originalTooLarge === true || response.result.modifiedTooLarge === true) {
    return { ...resultIdentity(args.payload), kind: 'too-large', reason: 'host-limit' }
  }
  if (
    typeof response.result.original !== 'string' ||
    typeof response.result.modified !== 'string'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return buildMobileWebProviderReviewContentDiffPage({
    ...pageInput(
      args.payload,
      reviewDiffRevision(response.result.original, response.result.modified)
    ),
    originalContent: response.result.original,
    modifiedContent: response.result.modified
  })
}

function readGitLabReviewDiff(
  payload: MobileWebProviderReviewDiffPayload,
  details: unknown,
  file: MobileWebProviderReviewFile
): MobileWebProviderReviewDiffResult {
  if (file.isBinary) {
    return binaryResult(payload)
  }
  const rawFile = providerFile(details, file.path)
  if (!rawFile || typeof rawFile.diff !== 'string') {
    throw new MobileWebBrokerError('host_error')
  }
  return buildMobileWebProviderReviewPatchDiffPage({
    ...pageInput(payload, reviewDiffRevision(rawFile.diff)),
    patch: rawFile.diff
  })
}

function pageInput(payload: MobileWebProviderReviewDiffPayload, revision: string) {
  return {
    ...resultIdentity(payload),
    revision,
    offset: payload.offset,
    limit: payload.limit,
    ...(payload.focusLine === undefined ? {} : { focusLine: payload.focusLine })
  }
}

function resultIdentity(payload: MobileWebProviderReviewDiffPayload) {
  return {
    workspaceId: payload.workspaceId,
    observedHead: payload.expectedHead,
    branch: payload.expectedBranch,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    reviewHead: payload.expectedReviewHead,
    path: payload.path
  }
}

function binaryResult(
  payload: MobileWebProviderReviewDiffPayload
): MobileWebProviderReviewDiffResult {
  return { ...resultIdentity(payload), kind: 'binary' }
}

function assertRequestedPageIdentity(
  payload: MobileWebProviderReviewDiffPayload,
  result: MobileWebProviderReviewDiffResult
): void {
  if (
    payload.expectedRevision &&
    (result.kind !== 'text' || result.revision !== payload.expectedRevision)
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  if (
    payload.focusLine !== undefined &&
    (result.kind !== 'text' || result.focusLine !== payload.focusLine)
  ) {
    throw new MobileWebBrokerError('conflict')
  }
}

function reviewPosition(details: unknown): { headSha: string; baseSha: string } | null {
  if (!isRecord(details)) {
    return null
  }
  const headSha = boundedHead(details.headSha)
  const baseSha = boundedHead(details.baseSha)
  return headSha && baseSha ? { headSha, baseSha } : null
}

function providerFile(details: unknown, path: string): Record<string, unknown> | null {
  if (!isRecord(details) || !Array.isArray(details.files)) {
    return null
  }
  const candidate = details.files.find((entry) => isRecord(entry) && entry.path === path)
  return isRecord(candidate) ? candidate : null
}

function reviewDiffRevision(...values: string[]): string {
  const digest = sha256.create()
  for (const value of values) {
    digest.update(new TextEncoder().encode(value))
    digest.update(Uint8Array.of(0))
  }
  return Buffer.from(digest.digest()).toString('hex')
}

function boundedHead(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
