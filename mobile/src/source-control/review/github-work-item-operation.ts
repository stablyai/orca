import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { SendRequestOptions } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { GitHubOwnerRepo } from '../../../../src/shared/github/pull-request-types'
import { hasReachedAppVersion } from '../../../../src/shared/app-version'
import {
  GITHUB_EXACT_OPERATION_UNSUPPORTED,
  matchesGitHubWorkItemTarget,
  type GitHubWorkItemTarget
} from '../../../../src/shared/github/work-item-target'
import {
  captureGitHubInvocation,
  GITHUB_DESKTOP_UPDATE_REQUIRED,
  GITHUB_TARGET_CHECK_TIMED_OUT,
  supportsExactGitHubOperations,
  githubOperationResponse
} from './github-target-invocation'
import { openRpcRequestBudget } from '../../transport/rpc/rpc-request-budget'
import { readGitHubWorkItemByNumber } from '../../tasks/providers/mobile-task-source-search-operations'
import {
  GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY,
  GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY
} from '../../../../src/shared/work-items/task-source-runtime-capabilities'

// Before this release an unaddressed issue write ignored the issue source its own number lookup honors.
const ISSUE_WRITE_FOLLOWS_LOOKUP_VERSION = '1.4.221'

export async function withGitHubTargetOperation<T>(args: {
  client: RpcClient
  params: { repo: string }
  ownerRepo: GitHubOwnerRepo
  read?: boolean
  /** An addressed details read's intent: false for an ordinary load, true for the user's explicit Refresh. */
  canonical?: boolean
  /** A write's item, which a server without exact targets may still update unaddressed once its own lookup proves it. */
  issueTarget?: GitHubWorkItemTarget
  send: (
    client: RpcClient,
    exact: { ownerRepo?: GitHubOwnerRepo; canonical?: boolean },
    options: SendRequestOptions
  ) => Promise<T>
}): Promise<T> {
  const { client, intermediary } = args.client.requestRoute?.(args.params) ?? {
    client: args.client
  }
  const invocation = captureGitHubInvocation(client)
  const { assertCurrent } = invocation
  // The checks and the action share one 30-second budget, so a dead server fails once, not per leg.
  const budget = openRpcRequestBudget({ timeoutMs: 30_000, budgetSpansConnect: true })
  const remaining = () => {
    const ms = (budget.deadline ?? Date.now()) - Date.now()
    if (ms <= 0) {
      throw new Error(GITHUB_TARGET_CHECK_TIMED_OUT)
    }
    return ms
  }
  const options = () => ({
    timeoutMs: remaining(),
    failWhenDisconnected: true,
    beforeSend: assertCurrent
  })
  try {
    assertCurrent()
    // Both legs must honor the existing source fence for capability-shaped generic operations.
    const relayStatus = intermediary ? await invocationStatus(intermediary, options()) : null
    assertCurrent()
    const status = await invocation.status(options())
    assertCurrent()
    const serverSupports = supportsExactGitHubOperations(status)
    const relaySupports =
      !intermediary || (relayStatus !== null && supportsExactGitHubOperations(relayStatus))
    const supports = serverSupports && relaySupports
    const source =
      status.runtimeId && status.hostDescriptor?.installationId
        ? { sourceId: status.hostDescriptor.installationId, runtimeId: status.runtimeId }
        : null
    // Mixed versions: a host advertising explicit intent receives it; a canonical-only host predates exact targets, so
    // it reads ordinary loads without the owner and Refresh with the owner only, unbound as the desktop sends it; a
    // host with neither keeps today's params for both.
    const capabilities = args.canonical === undefined ? [] : (status.capabilities ?? [])
    const explicitIntent = capabilities.includes(
      GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY
    )
    const canonicalOnly =
      !explicitIntent && capabilities.includes(GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY)
    const exact = supports && source !== null
    const sendOwner = canonicalOnly ? args.canonical === true : exact
    if (
      !exact &&
      !args.read &&
      !(await serverFollowsIssueLookup(client, status, args.params.repo, args.issueTarget, options))
    ) {
      // Name the build to update: the relaying desktop when only it lacks the check, else the executing server.
      throw new Error(
        serverSupports && source && !relaySupports
          ? GITHUB_DESKTOP_UPDATE_REQUIRED
          : GITHUB_EXACT_OPERATION_UNSUPPORTED
      )
    }
    const result = await args.send(
      {
        ...client,
        sendRequest: async (method, params, requestOptions) =>
          githubOperationResponse(await client.sendRequest(method, params, requestOptions))
      },
      {
        ...(sendOwner ? { ownerRepo: args.ownerRepo } : {}),
        ...(explicitIntent ? { canonical: args.canonical } : {})
      },
      {
        ...options(),
        ...(supports && source ? { envelope: { expectedRuntimeSource: source } } : {})
      }
    )
    if (args.read) {
      assertCurrent()
    }
    return result
  } finally {
    invocation.retire()
  }
}

// Without ownerRepo a server writes to the issue its own number lookup finds, so a lookup landing on the target proves it.
async function serverFollowsIssueLookup(
  client: RpcClient,
  status: Record<string, unknown>,
  repo: string,
  target: GitHubWorkItemTarget | undefined,
  options: () => SendRequestOptions
): Promise<boolean> {
  if (
    target?.type !== 'issue' ||
    typeof status.appVersion !== 'string' ||
    !hasReachedAppVersion(status.appVersion, ISSUE_WRITE_FOLLOWS_LOOKUP_VERSION)
  ) {
    return false
  }
  const item = await readGitHubWorkItemByNumber(
    client,
    { repo, number: target.number, type: 'issue' },
    options()
  )
  return matchesGitHubWorkItemTarget(item, target)
}

async function invocationStatus(client: RpcClient, options: SendRequestOptions) {
  const invocation = captureGitHubInvocation(client)
  try {
    return await invocation.status(options)
  } finally {
    invocation.retire()
  }
}
