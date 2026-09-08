import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileWebProviderReviewEligibilityResult } from '../../../src/shared/mobile-web/provider-review-creation-contract'
import type { WebHostSourceControlStatusSnapshot } from './web-host-source-control-status-snapshot'

type RequestParams = Record<string, unknown>

export type WebHostProviderReviewEligibilityCache = {
  pending: Map<string, Promise<MobileWebProviderReviewEligibilityResult>>
  settled: Map<string, MobileWebProviderReviewEligibilityResult>
}

export function createWebHostProviderReviewEligibilityCache(): WebHostProviderReviewEligibilityCache {
  return { pending: new Map(), settled: new Map() }
}

export async function handleWebHostProviderReviewCreation(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  method: string
  params: RequestParams
  eligibilityCache: WebHostProviderReviewEligibilityCache
  statusSnapshot: WebHostSourceControlStatusSnapshot
}): Promise<unknown | typeof WEB_HOST_PROVIDER_REVIEW_CREATION_UNHANDLED> {
  if (
    args.method !== 'hostedReview.getCreationEligibility' &&
    args.method !== 'hostedReview.create' &&
    args.method !== 'git.generatePullRequestFields'
  ) {
    return WEB_HOST_PROVIDER_REVIEW_CREATION_UNHANDLED
  }
  const status = await args.statusSnapshot.read()
  if (!status.head || !status.branch) {
    throw new Error('conflict')
  }
  const identity = {
    workspaceId: args.workspaceId,
    expectedHead: status.head,
    expectedBranch: status.branch
  }
  if (args.method === 'hostedReview.getCreationEligibility') {
    const result = await loadWebHostProviderReviewEligibility({
      client: args.client,
      identity,
      base:
        args.params.base === null || args.params.base === undefined
          ? undefined
          : requiredString(args.params.base),
      cache: args.eligibilityCache
    })
    const {
      workspaceId: _workspaceId,
      observedHead: _observedHead,
      branch: _branch,
      ...eligibility
    } = result
    return eligibility
  }
  if (args.method === 'git.generatePullRequestFields') {
    const result = await args.client.providerReviewGenerateFields({
      ...identity,
      base: requiredString(args.params.base),
      title: optionalString(args.params.title),
      body: optionalString(args.params.body),
      draft: args.params.draft === true
    })
    const { workspaceId: _workspaceId, ...fields } = result
    return fields
  }
  const result = await args.client.providerReviewCreate({
    ...identity,
    provider: requiredProvider(args.params.provider),
    base: requiredString(args.params.base),
    ...(args.params.head === undefined ? {} : { head: requiredString(args.params.head) }),
    title: requiredString(args.params.title),
    body: optionalString(args.params.body),
    draft: args.params.draft === true,
    ...(args.params.useTemplate === undefined
      ? {}
      : { useTemplate: requiredBoolean(args.params.useTemplate) })
  })
  const { workspaceId: _workspaceId, provider: _provider, ...created } = result
  return created
}

export const WEB_HOST_PROVIDER_REVIEW_CREATION_UNHANDLED = Symbol(
  'provider-review-creation-unhandled'
)

export async function loadWebHostProviderReviewEligibility(args: {
  client: MobileWebBridgeClient
  identity: {
    workspaceId: string
    expectedHead: string
    expectedBranch: string
  }
  base?: string
  cache: WebHostProviderReviewEligibilityCache
}): Promise<MobileWebProviderReviewEligibilityResult> {
  const key = `${args.identity.expectedHead}\0${args.identity.expectedBranch}\0${args.base ?? ''}`
  const pending = args.cache.pending.get(key)
  if (pending) {
    return pending
  }
  const request = args.client.providerReviewCreationEligibility({
    ...args.identity,
    ...(args.base === undefined ? {} : { base: args.base })
  })
  args.cache.pending.set(key, request)
  try {
    const result = await request
    if (args.base === undefined) {
      args.cache.settled.clear()
      args.cache.settled.set(key, result)
    }
    return result
  } finally {
    if (args.cache.pending.get(key) === request) {
      args.cache.pending.delete(key)
    }
  }
}

export function takeWebHostProviderReviewEligibility(
  cache: WebHostProviderReviewEligibilityCache,
  identity: {
    expectedHead: string
    expectedBranch: string
  }
): MobileWebProviderReviewEligibilityResult | null {
  const key = `${identity.expectedHead}\0${identity.expectedBranch}\0`
  const result = cache.settled.get(key) ?? null
  cache.settled.delete(key)
  return result
}

function requiredProvider(
  value: unknown
): 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea' {
  if (
    value !== 'github' &&
    value !== 'gitlab' &&
    value !== 'bitbucket' &&
    value !== 'azure-devops' &&
    value !== 'gitea'
  ) {
    throw new Error('invalid_request')
  }
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('invalid_request')
  }
  return value.trim()
}

function optionalString(value: unknown): string {
  if (value === undefined) {
    return ''
  }
  if (typeof value !== 'string') {
    throw new Error('invalid_request')
  }
  return value
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('invalid_request')
  }
  return value
}
