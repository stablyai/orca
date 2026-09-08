import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'

type RequestParams = Record<string, unknown>

const ENTRY_MUTATIONS: Record<string, 'stage' | 'unstage' | 'discard'> = {
  'git.stage': 'stage',
  'git.bulkStage': 'stage',
  'git.unstage': 'unstage',
  'git.bulkUnstage': 'unstage',
  'git.discard': 'discard',
  'git.bulkDiscard': 'discard'
}

export async function mutateWebHostSourceControlRequest(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  method: string
  params: RequestParams
}): Promise<unknown | typeof WEB_HOST_SOURCE_CONTROL_MUTATION_UNHANDLED> {
  const { client, workspaceId, method, params } = args
  const entryMutation = ENTRY_MUTATIONS[method]
  if (entryMutation) {
    const payload = { workspaceId, relativePaths: requestedPaths(params) }
    if (entryMutation === 'stage') {
      await client.sourceControlStage(payload)
    } else if (entryMutation === 'unstage') {
      await client.sourceControlUnstage(payload)
    } else {
      await client.sourceControlDiscard(payload)
    }
    return { success: true }
  }
  if (method === 'git.commit') {
    return client.sourceControlCommit({ workspaceId, message: requiredString(params.message) })
  }
  if (method === 'git.generateCommitMessage') {
    const result = await client.sourceControlGenerateCommitMessage({
      workspaceId,
      expectedHead: await currentHead(client, workspaceId)
    })
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
    await client.sourceControlReviewLinkUpdate({ workspaceId, ...reviewLinkUpdate(params) })
    return { success: true }
  }
  if (method === 'git.checkout') {
    await client.sourceControlCheckout({ workspaceId, branch: requiredString(params.branch) })
    return { success: true }
  }
  return mutateRepository(client, workspaceId, method, params)
}

export const WEB_HOST_SOURCE_CONTROL_MUTATION_UNHANDLED = Symbol('source-control-unhandled')

async function mutateRepository(
  client: MobileWebBridgeClient,
  workspaceId: string,
  method: string,
  params: RequestParams
) {
  if (method === 'git.fetch') {
    await client.sourceControlFetch({ workspaceId })
  } else if (method === 'git.pull' || method === 'git.fastForward') {
    await client.sourceControlPull({
      workspaceId,
      strategy: method === 'git.fastForward' ? 'fast-forward' : 'merge'
    })
  } else if (method === 'git.push') {
    await client.sourceControlPush({
      workspaceId,
      mode: params.publish === true ? 'publish' : 'push'
    })
  } else if (method === 'git.rebaseFromBase') {
    await client.sourceControlRebase({ workspaceId, baseRef: requiredString(params.baseRef) })
  } else if (method === 'git.abortMerge' || method === 'git.abortRebase') {
    await client.sourceControlAbort({
      workspaceId,
      conflictOperation: method === 'git.abortMerge' ? 'merge' : 'rebase'
    })
  } else {
    return WEB_HOST_SOURCE_CONTROL_MUTATION_UNHANDLED
  }
  return { success: true }
}

/** Generation echoes the HEAD it started from, which is how a stale draft is recognised. */
async function currentHead(client: MobileWebBridgeClient, workspaceId: string): Promise<string> {
  const repository = await client.sourceControlRepositoryState({ workspaceId })
  if (!repository.head) {
    throw new Error('conflict')
  }
  return repository.head
}

function requestedPaths(params: RequestParams): string[] {
  const values = Array.isArray(params.filePaths) ? params.filePaths : [params.filePath]
  const paths = values.filter((value): value is string => typeof value === 'string')
  if (paths.length === 0) {
    throw new Error('invalid_request')
  }
  return paths
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
