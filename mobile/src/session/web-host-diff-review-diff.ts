import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import {
  MOBILE_WEB_DIFF_MAX_ROWS,
  MOBILE_WEB_DIFF_PAGE_LIMIT,
  type MobileWebDiffRow
} from '../../../src/shared/mobile-web/source-control-operation-contract'
import type {
  MobileWebSourceControlReviewDiffPayload,
  MobileWebSourceControlReviewDiffResult
} from '../../../src/shared/mobile-web/source-control-review-contract'

export async function readWebHostDiffReviewDiff(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  method: string
  params: Record<string, unknown>
}) {
  const payload = diffPayload(args.workspaceId, args.method, args.params)
  const rows: MobileWebDiffRow[] = []
  let expectedRevision: string | undefined
  let offset = 0
  let truncated = false
  for (;;) {
    const page = await args.client.sourceControlReviewDiff({
      ...payload,
      offset,
      limit: MOBILE_WEB_DIFF_PAGE_LIMIT,
      ...(expectedRevision ? { expectedRevision } : {})
    })
    if (page.kind !== 'text') {
      return nonTextResult(page)
    }
    if (expectedRevision && page.revision !== expectedRevision) {
      throw new Error('conflict')
    }
    expectedRevision = page.revision
    rows.push(...page.rows)
    truncated ||= page.truncated || page.rows.some((row) => row.textTruncated)
    if (page.nextOffset === null) {
      return {
        kind: 'rows',
        rows: rows.map(({ index: _index, textTruncated: _textTruncated, ...row }) => row),
        truncated
      }
    }
    if (page.nextOffset <= offset || page.nextOffset > MOBILE_WEB_DIFF_MAX_ROWS) {
      throw new Error('invalid_message')
    }
    offset = page.nextOffset
  }
}

function diffPayload(
  workspaceId: string,
  method: string,
  params: Record<string, unknown>
): Omit<MobileWebSourceControlReviewDiffPayload, 'offset' | 'limit' | 'expectedRevision'> {
  const relativePath = requiredString(params.filePath)
  if (method === 'git.branchDiff') {
    const compare = requiredRecord(params.compare)
    return {
      workspaceId,
      relativePath,
      ...(safeString(params.oldPath) ? { oldRelativePath: safeString(params.oldPath) } : {}),
      scope: 'branch',
      compare: {
        baseRef: requiredString(compare.baseRef),
        ...(safeString(compare.baseOid) ? { baseOid: safeString(compare.baseOid) } : {}),
        headOid: requiredString(compare.headOid),
        mergeBase: requiredString(compare.mergeBase)
      }
    }
  }
  return {
    workspaceId,
    relativePath,
    scope: params.staged === true ? 'staged' : 'unstaged'
  }
}

function nonTextResult(result: Exclude<MobileWebSourceControlReviewDiffResult, { kind: 'text' }>) {
  if (result.kind === 'binary') {
    return { kind: 'binary' as const }
  }
  return {
    kind: 'too-large' as const,
    ...(result.characterCount === undefined ? {} : { byteLength: result.characterCount })
  }
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_request')
  }
  return value as Record<string, unknown>
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requiredString(value: unknown): string {
  const result = safeString(value)
  if (!result) {
    throw new Error('invalid_request')
  }
  return result
}
