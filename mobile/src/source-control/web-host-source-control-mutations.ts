import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileWebSourceControlStatusEntry } from '../../../src/shared/mobile-web/source-control-operation-contract'

type RequestParams = Record<string, unknown>

export async function mutateWebHostSourceControlRequest(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  method: string
  params: RequestParams
}): Promise<unknown | typeof WEB_HOST_SOURCE_CONTROL_MUTATION_UNHANDLED> {
  const { client, workspaceId, method, params } = args
  if (
    method === 'git.stage' ||
    method === 'git.bulkStage' ||
    method === 'git.unstage' ||
    method === 'git.bulkUnstage' ||
    method === 'git.discard'
  ) {
    return mutateEntries(client, workspaceId, method, params)
  }
  if (method === 'git.commit') {
    const snapshot = await commitSnapshot(client, workspaceId)
    const result = await client.sourceControlCommit({
      ...snapshot,
      message: requiredString(params.message)
    })
    return result.status === 'committed'
      ? { success: true }
      : { success: false, error: result.error }
  }
  if (method === 'git.generateCommitMessage') {
    const result = await client.sourceControlGenerateCommitMessage(
      await commitSnapshot(client, workspaceId)
    )
    return result.status === 'generated'
      ? { success: true, message: result.message }
      : {
          success: false,
          error: result.status === 'failed' ? result.error : 'Generation cancelled',
          ...(result.status === 'cancelled' ? { canceled: true } : {})
        }
  }
  if (method === 'git.cancelGenerateCommitMessage') {
    await client.sourceControlCancelCommitMessageGeneration({ workspaceId })
    return { success: true }
  }
  if (method === 'worktree.set') {
    const update = reviewLinkUpdate(params)
    await client.sourceControlReviewLinkUpdate({ workspaceId, ...update })
    return { success: true }
  }
  if (method === 'git.checkout') {
    const repository = await client.sourceControlUpstream({ workspaceId })
    await client.sourceControlCheckout({
      ...repositoryIdentity(repository),
      branch: requiredString(params.branch),
      confirmation: 'checkout-confirmed'
    })
    return { success: true }
  }
  if (
    method === 'git.fetch' ||
    method === 'git.pull' ||
    method === 'git.fastForward' ||
    method === 'git.push' ||
    method === 'git.rebaseFromBase' ||
    method === 'git.abortMerge' ||
    method === 'git.abortRebase'
  ) {
    return mutateRepository(client, workspaceId, method, params)
  }
  return WEB_HOST_SOURCE_CONTROL_MUTATION_UNHANDLED
}

export const WEB_HOST_SOURCE_CONTROL_MUTATION_UNHANDLED = Symbol('source-control-unhandled')

async function mutateEntries(
  client: MobileWebBridgeClient,
  workspaceId: string,
  method: string,
  params: RequestParams
) {
  const status = await client.sourceControlStatus({ workspaceId, limit: 64 })
  const paths = requestedPaths(params)
  const entries = paths.map((path) => {
    const entry = status.entries.find((candidate) => candidate.relativePath === path)
    if (!entry) {
      throw new Error('conflict')
    }
    return mutationEntry(entry)
  })
  const expectedHead = status.head ?? null
  if (method === 'git.stage' || method === 'git.bulkStage') {
    await client.sourceControlStage({ workspaceId, expectedHead, entries })
  } else if (method === 'git.unstage' || method === 'git.bulkUnstage') {
    await client.sourceControlUnstage({ workspaceId, expectedHead, entries })
  } else {
    await client.sourceControlDiscard({
      workspaceId,
      expectedHead,
      entries,
      confirmation: 'discard-confirmed'
    })
  }
  return { success: true }
}

async function commitSnapshot(client: MobileWebBridgeClient, workspaceId: string) {
  const status = await client.sourceControlStatus({ workspaceId, limit: 64 })
  if (!status.head) {
    throw new Error('conflict')
  }
  return {
    workspaceId,
    expectedHead: status.head,
    stagedEntries: status.entries
      .filter((entry) => entry.area === 'staged')
      .map((entry) => ({ ...mutationEntry(entry), area: 'staged' as const }))
  }
}

async function mutateRepository(
  client: MobileWebBridgeClient,
  workspaceId: string,
  method: string,
  params: RequestParams
) {
  const repository = await client.sourceControlUpstream({ workspaceId })
  const identity = repositoryIdentity(repository)
  if (method === 'git.fetch') {
    await client.sourceControlFetch(identity)
  } else if (method === 'git.pull' || method === 'git.fastForward') {
    await client.sourceControlPull({
      ...identity,
      expectedUpstream: repository.upstream,
      strategy: method === 'git.fastForward' ? 'fast-forward' : 'merge',
      confirmation: 'pull-confirmed'
    })
  } else if (method === 'git.push') {
    await client.sourceControlPush({
      ...identity,
      expectedUpstream: repository.upstream,
      mode: params.publish === true ? 'publish' : 'push',
      confirmation: 'push-confirmed'
    })
  } else if (method === 'git.rebaseFromBase') {
    await client.sourceControlRebase({
      ...identity,
      expectedUpstream: repository.upstream,
      baseRef: requiredString(params.baseRef),
      confirmation: 'rebase-confirmed'
    })
  } else {
    await client.sourceControlAbort({
      ...identity,
      conflictOperation: method === 'git.abortMerge' ? 'merge' : 'rebase',
      confirmation: 'abort-confirmed'
    })
  }
  return { success: true }
}

function repositoryIdentity(repository: {
  workspaceId: string
  head: string | null
  branch: string | null
}) {
  return {
    workspaceId: repository.workspaceId,
    expectedHead: repository.head,
    expectedBranch: repository.branch
  }
}

function requestedPaths(params: RequestParams): string[] {
  const values = Array.isArray(params.filePaths) ? params.filePaths : [params.filePath]
  const paths = values.filter((value): value is string => typeof value === 'string')
  if (paths.length === 0) {
    throw new Error('invalid_request')
  }
  return paths
}

function mutationEntry(entry: MobileWebSourceControlStatusEntry) {
  return {
    relativePath: entry.relativePath,
    ...(entry.oldRelativePath ? { oldRelativePath: entry.oldRelativePath } : {}),
    status: entry.status,
    area: entry.area,
    ...(entry.conflictStatus ? { conflictStatus: entry.conflictStatus } : {})
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('invalid_request')
  }
  return value
}

function reviewLinkUpdate(params: RequestParams): {
  provider: 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea'
  number: number | null
  baseRef?: string
} {
  const candidates = [
    ['github', 'linkedPR'],
    ['gitlab', 'linkedGitLabMR'],
    ['bitbucket', 'linkedBitbucketPR'],
    ['azure-devops', 'linkedAzureDevOpsPR'],
    ['gitea', 'linkedGiteaPR']
  ] as const
  const selected = candidates.filter(([, key]) => params[key] !== undefined)
  if (selected.length !== 1) {
    throw new Error('invalid_request')
  }
  const [provider, key] = selected[0]!
  const value = params[key]
  if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('invalid_request')
  }
  const baseRef = params.baseRef === undefined ? undefined : requiredString(params.baseRef)
  return { provider, number: value, ...(baseRef ? { baseRef } : {}) }
}
