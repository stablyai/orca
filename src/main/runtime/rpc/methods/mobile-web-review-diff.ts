import { createHash } from 'node:crypto'
import type { z } from 'zod'
import {
  MobileWebProviderReviewDiffHostParamsSchema,
  type MobileWebProviderReviewDiffResult
} from '../../../../shared/mobile-web/provider-review-diff-contract'
import type { MobileWebProviderReview } from '../../../../shared/mobile-web/provider-review-contract'
import { defineMethod, type RpcContext } from '../core'
import { projectMobileWebReview } from './mobile-web-review-projection'
import {
  buildMobileWebReviewContentDiffPage,
  buildMobileWebReviewPatchDiffPage
} from './mobile-web-review-diff-page'
import {
  readMobileWebReviewTarget,
  type MobileWebReviewDetails,
  type MobileWebReviewPageResult
} from './mobile-web-review-scope'
import { gitHubReviewTarget, reviewInlinePosition } from './mobile-web-review-targets'

type LoadedDetails = Extract<MobileWebReviewDetails, { state: 'loaded' }>
type ReviewFile = MobileWebProviderReview['files'][number]
type DiffParams = z.infer<typeof MobileWebProviderReviewDiffHostParamsSchema>
type DiffPage = MobileWebReviewPageResult<MobileWebProviderReviewDiffResult>

/** A review diff is the provider's own file contents, not the working tree's, so the page's rows
 *  are paged out of a diff this host builds and clips to one transport payload. */
const MAX_DIFF_RESULT_BYTES = 512 * 1024

export const MOBILE_WEB_REVIEW_DIFF_METHOD = defineMethod({
  name: 'mobileWeb.review.diff',
  params: MobileWebProviderReviewDiffHostParamsSchema,
  handler: async (params, context): Promise<DiffPage> => {
    const { repo, summary, details } = await readMobileWebReviewTarget(context, params)
    if (details.state !== 'loaded') {
      throw new Error('conflict')
    }
    const review = projectMobileWebReview(summary, details)
    const file = review.files.find((candidate) => candidate.path === params.path)
    if (review.headSha !== params.expectedReviewHead || !file) {
      throw new Error('conflict')
    }
    const page =
      details.provider === 'github'
        ? await readGitHubReviewDiff({ context, repo, payload: params, details, file })
        : readGitLabReviewDiff(params, details, file)
    assertRequestedPage(params, page)
    return clipDiffRows(page)
  }
})

async function readGitHubReviewDiff(args: {
  context: RpcContext
  repo: string
  payload: DiffParams
  details: LoadedDetails
  file: ReviewFile
}): Promise<DiffPage> {
  const position = reviewInlinePosition(args.details, args.payload.expectedReviewHead)
  if (!position?.baseSha) {
    throw new Error('conflict')
  }
  if (args.file.isBinary) {
    return binaryPage(args.payload)
  }
  const contents = await args.context.runtime.getRepoPRFileContents(args.repo, {
    prNumber: args.payload.reviewNumber,
    prRepo: gitHubReviewTarget(args.details),
    path: args.file.path,
    oldPath: args.file.oldPath,
    status: args.file.status,
    headSha: position.headSha,
    baseSha: position.baseSha
  })
  if (contents.originalIsBinary || contents.modifiedIsBinary) {
    return binaryPage(args.payload)
  }
  if (contents.originalTooLarge === true || contents.modifiedTooLarge === true) {
    return { ...pageIdentity(args.payload), kind: 'too-large', reason: 'host-limit' }
  }
  return buildMobileWebReviewContentDiffPage({
    ...pageInput(args.payload, diffRevision(contents.original, contents.modified)),
    originalContent: contents.original,
    modifiedContent: contents.modified
  })
}

/** GitLab already ships the merge-request patch inside the work item, so no second read is due. */
function readGitLabReviewDiff(
  payload: DiffParams,
  details: LoadedDetails,
  file: ReviewFile
): DiffPage {
  if (file.isBinary) {
    return binaryPage(payload)
  }
  const patch =
    details.provider === 'gitlab'
      ? details.item.files?.find((candidate) => candidate.path === file.path)?.diff
      : undefined
  if (patch === undefined) {
    throw new Error('host_error')
  }
  return buildMobileWebReviewPatchDiffPage({ ...pageInput(payload, diffRevision(patch)), patch })
}

/** Escaped line text can exceed the byte budget even within the row-count limit. A focused page
 *  keeps its focus row: the schema requires it, so dropping it would fail the whole read. */
function clipDiffRows(page: DiffPage): DiffPage {
  if (page.kind !== 'text') {
    return page
  }
  const clipped = { ...page, rows: [...page.rows] }
  while (
    Buffer.byteLength(JSON.stringify(clipped)) > MAX_DIFF_RESULT_BYTES &&
    clipped.rows.length > 1
  ) {
    if (clipped.rows.at(-1)?.index === page.focusRowIndex) {
      clipped.rows.shift()
      clipped.offset += 1
    } else {
      clipped.rows.pop()
      clipped.nextOffset = clipped.offset + clipped.rows.length
    }
  }
  return clipped
}

function pageInput(payload: DiffParams, revision: string) {
  return {
    ...pageIdentity(payload),
    revision,
    offset: payload.offset,
    limit: payload.limit,
    ...(payload.focusLine === undefined ? {} : { focusLine: payload.focusLine })
  }
}

function pageIdentity(payload: DiffParams) {
  return {
    observedHead: payload.expectedHead,
    branch: payload.expectedBranch,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    reviewHead: payload.expectedReviewHead,
    path: payload.path
  }
}

function binaryPage(payload: DiffParams): DiffPage {
  return { ...pageIdentity(payload), kind: 'binary' }
}

/** A page the caller asked to match a revision or centre on a line must do exactly that; anything
 *  else means the review moved between pages. */
function assertRequestedPage(payload: DiffParams, page: DiffPage): void {
  if (
    payload.expectedRevision &&
    (page.kind !== 'text' || page.revision !== payload.expectedRevision)
  ) {
    throw new Error('conflict')
  }
  if (
    payload.focusLine !== undefined &&
    (page.kind !== 'text' || page.focusLine !== payload.focusLine)
  ) {
    throw new Error('conflict')
  }
}

function diffRevision(...values: string[]): string {
  const digest = createHash('sha256')
  for (const value of values) {
    digest.update(value, 'utf8')
    digest.update(Uint8Array.of(0))
  }
  return digest.digest('hex')
}
