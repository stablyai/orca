import {
  MobileWebSourceControlAbortPayloadSchema,
  MobileWebSourceControlCheckoutPayloadSchema,
  MobileWebSourceControlFetchPayloadSchema,
  MobileWebSourceControlPullPayloadSchema,
  MobileWebSourceControlPushPayloadSchema,
  MobileWebSourceControlRebasePayloadSchema,
  MobileWebSourceControlSyncResultSchema,
  MobileWebSourceControlUpstreamPayloadSchema,
  type MobileWebSourceControlRepositoryState,
  type MobileWebSourceControlSyncOperation,
  type MobileWebSourceControlSyncResult
} from '../../../src/shared/mobile-web/source-control-sync-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  readMobileWebSourceControlRepositoryState,
  readMobileWebSourceControlStatusIdentity,
  tryReadMobileWebSourceControlRepositoryState
} from './mobile-web-source-control-repository-state'
import {
  assertMobileWebExpectedUpstream,
  assertMobileWebNoConflictOperation,
  assertMobileWebRepositoryIdentity
} from './mobile-web-source-control-sync-preflight'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type SyncOperation = 'upstream' | MobileWebSourceControlSyncOperation

export function isMobileWebSourceControlSyncOperation(
  operation: string
): operation is SyncOperation {
  return (
    operation === 'upstream' ||
    operation === 'branch' ||
    operation === 'fetch' ||
    operation === 'pull' ||
    operation === 'push' ||
    operation === 'rebase' ||
    operation === 'abort'
  )
}

export async function executeMobileWebSourceControlSyncOperation(args: {
  operation: SyncOperation
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<MobileWebSourceControlRepositoryState | MobileWebSourceControlSyncResult> {
  if (args.operation === 'upstream') {
    const payload = MobileWebSourceControlUpstreamPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    return readMobileWebSourceControlRepositoryState(
      args.client,
      payload.workspaceId,
      hostWorkspaceId
    )
  }
  if (args.operation === 'branch') {
    return checkoutBranch(args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'fetch') {
    return fetchRepository(args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'pull') {
    return pullRepository(args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'push') {
    return pushRepository(args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'rebase') {
    return rebaseRepository(args.payload, args.client, args.workspaceAuthority)
  }
  return abortConflictOperation(args.payload, args.client, args.workspaceAuthority)
}

async function checkoutBranch(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
) {
  const payload = MobileWebSourceControlCheckoutPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const previous = await preflightIdentity(client, payload, hostWorkspaceId)
  assertMobileWebNoConflictOperation(previous)
  const branches = await client.sendRequest('git.localBranches', {
    worktree: `id:${hostWorkspaceId}`
  })
  if (
    !branches.ok ||
    !isRecord(branches.result) ||
    !Array.isArray(branches.result.branches) ||
    !branches.result.branches.includes(payload.branch)
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  await requireSuccessfulWrite(
    client.sendRequest('git.checkout', {
      worktree: `id:${hostWorkspaceId}`,
      branch: payload.branch
    })
  )
  return actionResult(
    client,
    payload.workspaceId,
    hostWorkspaceId,
    'branch',
    previous,
    payload.branch
  )
}

async function fetchRepository(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
) {
  const payload = MobileWebSourceControlFetchPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const previous = await preflightIdentity(client, payload, hostWorkspaceId)
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  await requireSuccessfulWrite(
    client.sendRequest('git.fetch', { worktree: `id:${hostWorkspaceId}` })
  )
  return actionResult(client, payload.workspaceId, hostWorkspaceId, 'fetch', previous)
}

async function pullRepository(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
) {
  const payload = MobileWebSourceControlPullPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const previous = await preflightRemote(client, payload, hostWorkspaceId)
  assertMobileWebNoConflictOperation(previous)
  const upstream = previous.upstream
  if (
    !upstream.hasUpstream ||
    upstream.behind === 0 ||
    (payload.strategy === 'fast-forward' && upstream.ahead > 0) ||
    (payload.strategy === 'merge' && upstream.ahead === 0)
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  await requireSuccessfulWrite(
    client.sendRequest(payload.strategy === 'fast-forward' ? 'git.fastForward' : 'git.pull', {
      worktree: `id:${hostWorkspaceId}`
    })
  )
  return actionResult(client, payload.workspaceId, hostWorkspaceId, 'pull', previous)
}

async function pushRepository(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
) {
  const payload = MobileWebSourceControlPushPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const previous = await preflightRemote(client, payload, hostWorkspaceId)
  assertMobileWebNoConflictOperation(previous)
  const upstream = previous.upstream
  const canPush = upstream.hasUpstream || upstream.hasConfiguredPushTarget
  if (
    (payload.mode === 'publish' && canPush) ||
    (payload.mode === 'push' && (!canPush || (upstream.hasUpstream && upstream.ahead === 0)))
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  await requireSuccessfulWrite(
    client.sendRequest('git.push', {
      worktree: `id:${hostWorkspaceId}`,
      publish: payload.mode === 'publish'
    })
  )
  return actionResult(client, payload.workspaceId, hostWorkspaceId, 'push', previous)
}

async function rebaseRepository(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
) {
  const payload = MobileWebSourceControlRebasePayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const previous = await preflightRemote(client, payload, hostWorkspaceId)
  assertMobileWebNoConflictOperation(previous)
  if (previous.baseRef !== payload.baseRef) {
    throw new MobileWebBrokerError('conflict')
  }
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  await requireSuccessfulWrite(
    client.sendRequest('git.rebaseFromBase', {
      worktree: `id:${hostWorkspaceId}`,
      baseRef: payload.baseRef
    })
  )
  return actionResult(client, payload.workspaceId, hostWorkspaceId, 'rebase', previous)
}

async function abortConflictOperation(
  input: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
) {
  const payload = MobileWebSourceControlAbortPayloadSchema.parse(input)
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const previous = await preflightIdentity(client, payload, hostWorkspaceId)
  if (previous.conflictOperation !== payload.conflictOperation) {
    throw new MobileWebBrokerError('conflict')
  }
  workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  await requireSuccessfulWrite(
    client.sendRequest(
      payload.conflictOperation === 'merge' ? 'git.abortMerge' : 'git.abortRebase',
      { worktree: `id:${hostWorkspaceId}` }
    )
  )
  return actionResult(client, payload.workspaceId, hostWorkspaceId, 'abort', previous)
}

async function preflightIdentity(
  client: RpcClient,
  payload: { workspaceId: string; expectedHead: string | null; expectedBranch: string | null },
  hostWorkspaceId: string
) {
  const state = await readMobileWebSourceControlStatusIdentity(client, hostWorkspaceId)
  assertMobileWebRepositoryIdentity(state, payload)
  return state
}

async function preflightRemote(
  client: RpcClient,
  payload: Parameters<typeof preflightIdentity>[1] & {
    expectedUpstream: MobileWebSourceControlRepositoryState['upstream']
  },
  hostWorkspaceId: string
) {
  const state = await readMobileWebSourceControlRepositoryState(
    client,
    payload.workspaceId,
    hostWorkspaceId
  )
  assertMobileWebRepositoryIdentity(state, payload)
  assertMobileWebExpectedUpstream(state, payload.expectedUpstream)
  return state
}

async function actionResult(
  client: RpcClient,
  pageWorkspaceId: string,
  hostWorkspaceId: string,
  operation: MobileWebSourceControlSyncOperation,
  previous: Pick<MobileWebSourceControlRepositoryState, 'head' | 'branch'>,
  branch?: string
) {
  const result = {
    workspaceId: pageWorkspaceId,
    previousHead: previous.head,
    previousBranch: previous.branch,
    repository: await tryReadMobileWebSourceControlRepositoryState(
      client,
      pageWorkspaceId,
      hostWorkspaceId
    ),
    completed: true
  } as const
  if (operation === 'branch') {
    return MobileWebSourceControlSyncResultSchema.parse({
      ...result,
      operation,
      branch
    })
  }
  return MobileWebSourceControlSyncResultSchema.parse({ ...result, operation })
}

async function requireSuccessfulWrite(responsePromise: ReturnType<RpcClient['sendRequest']>) {
  const response = await responsePromise
  if (!response.ok || !isRecord(response.result) || response.result.ok !== true) {
    throw new MobileWebBrokerError('host_error')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
