import type { z } from 'zod'
import type { MobileWebBridgeOperationName } from '../../shared/mobile-web/bridge-operation-registry'
import {
  MobileWebCreationBranchSearchResultSchema,
  MobileWebCreationGitHubLookupPayloadSchema,
  MobileWebCreationGitHubLookupResultSchema,
  MobileWebCreationGitHubRepoLookupPayloadSchema,
  MobileWebCreationGitHubSearchResultSchema,
  MobileWebCreationGitLabLookupPayloadSchema,
  MobileWebCreationGitLabLookupResultSchema,
  MobileWebCreationGitLabSearchPayloadSchema,
  MobileWebCreationGitLabSearchResultSchema,
  MobileWebCreationHostedBaseResultSchema,
  MobileWebCreationLinearSearchPayloadSchema,
  MobileWebCreationLinearSearchResultSchema,
  MobileWebCreationMrBasePayloadSchema,
  MobileWebCreationPrBasePayloadSchema,
  MobileWebCreationRepoQueryPayloadSchema,
  MobileWebCreationRepoSlugResultSchema,
  type MobileWebCreationGitHubItem,
  type MobileWebCreationGitLabItem,
  type MobileWebCreationHostedBaseResult,
  type MobileWebCreationLinearIssue
} from '../../shared/mobile-web/workspace-creation-source-contract'
import { MobileWebCreationRepoPayloadSchema } from '../../shared/mobile-web/workspace-creation-read-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebWorkspaceCreationSourceRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  searchGitHub(repoId: string, query: string): Promise<MobileWebCreationGitHubItem[]> {
    return this.request(
      'creationSearchGitHub',
      { repoId, query },
      MobileWebCreationRepoQueryPayloadSchema,
      MobileWebCreationGitHubSearchResultSchema
    ).then((result) => matchingRepoItems(repoId, result.items))
  }

  searchGitLab(
    repoId: string,
    query: string,
    state: 'opened' | 'merged' | 'closed' | 'all'
  ): Promise<MobileWebCreationGitLabItem[]> {
    return this.request(
      'creationSearchGitLab',
      { repoId, query, state },
      MobileWebCreationGitLabSearchPayloadSchema,
      MobileWebCreationGitLabSearchResultSchema
    ).then((result) => matchingRepoItems(repoId, result.items))
  }

  searchLinear(
    query: string,
    linearWorkspaceId: string | null | undefined
  ): Promise<MobileWebCreationLinearIssue[]> {
    return this.request(
      'creationSearchLinear',
      { query, linearWorkspaceId },
      MobileWebCreationLinearSearchPayloadSchema,
      MobileWebCreationLinearSearchResultSchema
    ).then((result) => result.issues)
  }

  searchBranches(repoId: string, query: string) {
    return this.request(
      'creationSearchBranches',
      { repoId, query },
      MobileWebCreationRepoQueryPayloadSchema,
      MobileWebCreationBranchSearchResultSchema
    ).then((result) => result.branches)
  }

  resolveRepoSlug(repoId: string) {
    return this.request(
      'creationResolveRepoSlug',
      { repoId },
      MobileWebCreationRepoPayloadSchema,
      MobileWebCreationRepoSlugResultSchema
    )
  }

  lookupGitHub(repoId: string, number: number): Promise<MobileWebCreationGitHubItem | null> {
    return this.request(
      'creationLookupGitHub',
      { repoId, number },
      MobileWebCreationGitHubLookupPayloadSchema,
      MobileWebCreationGitHubLookupResultSchema
    ).then((result) => matchingLookup(result.item, { repoId, number }))
  }

  lookupGitHubRepo(payload: {
    repoId: string
    slug: { owner: string; repo: string; host?: string }
    number: number
    type: 'issue' | 'pr'
  }): Promise<MobileWebCreationGitHubItem | null> {
    return this.request(
      'creationLookupGitHubRepo',
      payload,
      MobileWebCreationGitHubRepoLookupPayloadSchema,
      MobileWebCreationGitHubLookupResultSchema
    ).then((result) => matchingLookup(result.item, payload))
  }

  lookupGitLab(payload: {
    repoId: string
    host: string
    path: string
    iid: number
    type: 'issue' | 'mr'
  }): Promise<MobileWebCreationGitLabItem | null> {
    return this.request(
      'creationLookupGitLab',
      payload,
      MobileWebCreationGitLabLookupPayloadSchema,
      MobileWebCreationGitLabLookupResultSchema
    ).then((result) =>
      matchingLookup(result.item, {
        repoId: payload.repoId,
        number: payload.iid,
        type: payload.type
      })
    )
  }

  resolvePrBase(payload: {
    repoId: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }): Promise<MobileWebCreationHostedBaseResult> {
    return this.request(
      'creationResolvePrBase',
      payload,
      MobileWebCreationPrBasePayloadSchema,
      MobileWebCreationHostedBaseResultSchema
    )
  }

  resolveMrBase(payload: {
    repoId: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }): Promise<MobileWebCreationHostedBaseResult> {
    return this.request(
      'creationResolveMrBase',
      payload,
      MobileWebCreationMrBasePayloadSchema,
      MobileWebCreationHostedBaseResultSchema
    )
  }

  private request<TPayload, TResult>(
    operation: MobileWebBridgeOperationName<'workspace'>,
    payload: TPayload,
    payloadSchema: z.ZodType<TPayload>,
    resultSchema: z.ZodType<TResult>
  ): Promise<TResult> {
    return this.requests.request('workspace', operation, payload, payloadSchema, resultSchema)
  }
}

function matchingRepoItems<TItem extends { repoId: string }>(
  repoId: string,
  items: TItem[]
): TItem[] {
  if (items.some((item) => item.repoId !== repoId)) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return items
}

function matchingLookup<
  TItem extends { repoId: string; number: number; type: string },
  TPayload extends { repoId: string; number: number; type?: string }
>(item: TItem | null, payload: TPayload): TItem | null {
  if (
    item &&
    (item.repoId !== payload.repoId ||
      item.number !== payload.number ||
      (payload.type !== undefined && item.type !== payload.type))
  ) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return item
}
