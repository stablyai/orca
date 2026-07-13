import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

type Respond = (response: RpcResponse) => void
type Success = (id: string, result: unknown) => RpcResponse

function repoSelectorToId(repoSelector: unknown): string | null {
  if (typeof repoSelector !== 'string') {
    return null
  }
  return repoSelector.startsWith('id:') ? repoSelector.slice(3) : repoSelector
}

export function handleMockWorkspaceSourceRequest(
  request: RpcRequest,
  respond: Respond,
  success: Success,
  defaultRepoId: string
): boolean {
  if (request.method === 'linear.status') {
    respond(success(request.id, { connected: true, selectedWorkspaceId: 'workspace-mock' }))
    return true
  }
  if (request.method === 'github.listWorkItems') {
    const repoId = repoSelectorToId(request.params?.repo) ?? defaultRepoId
    respond(
      success(request.id, {
        items: [
          {
            id: 'mock-issue-42',
            type: 'issue',
            number: 42,
            title: 'Improve mobile workspace creation',
            url: 'https://github.com/stablyai/orca/issues/42',
            repoId
          },
          {
            id: 'mock-pr-77',
            type: 'pr',
            number: 77,
            title: 'Add source selector',
            url: 'https://github.com/stablyai/orca/pull/77',
            branchName: 'feature/source-selector',
            baseRefName: 'main',
            repoId
          }
        ],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })
    )
    return true
  }
  if (request.method === 'linear.listIssues' || request.method === 'linear.searchIssues') {
    respond(
      success(request.id, [
        {
          id: 'linear-mock-1',
          workspaceId: 'workspace-mock',
          identifier: 'ENG-123',
          title: 'Polish mobile source search',
          url: 'https://linear.app/acme/issue/ENG-123/polish-mobile-source-search'
        }
      ])
    )
    return true
  }
  if (request.method === 'repo.searchRefs') {
    respond(
      success(request.id, {
        refDetails: [
          { refName: 'feature/mobile-ready', localBranchName: 'feature/mobile-ready' },
          { refName: 'origin/main', localBranchName: 'main' }
        ],
        refs: ['feature/mobile-ready', 'origin/main']
      })
    )
    return true
  }
  if (request.method === 'worktree.resolvePrBase') {
    respond(
      success(request.id, {
        baseBranch: 'refs/pull/77/head',
        compareBaseRef: 'origin/main',
        branchNameOverride: 'feature/source-selector',
        maintainerCanModify: true
      })
    )
    return true
  }
  return false
}
