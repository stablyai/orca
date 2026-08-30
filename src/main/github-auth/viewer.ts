import { githubApiGet, type GitHubApiResult } from './api-request'

export type GitHubViewer = {
  login: string | null
  name: string | null
  avatarUrl: string | null
}

type ViewerPayload = {
  login?: unknown
  name?: unknown
  avatar_url?: unknown
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function viewerFromPayload(payload: ViewerPayload): GitHubViewer {
  return {
    login: asOptionalString(payload.login),
    name: asOptionalString(payload.name),
    avatarUrl: asOptionalString(payload.avatar_url)
  }
}

// Verifying against `/user` before persisting keeps the stored "connected
// account" honest and lets the sign-in UI reject a dead token inline.
export function fetchGitHubViewer(
  token: string,
  timeoutMs = 8000
): Promise<GitHubApiResult<GitHubViewer>> {
  return githubApiGet<ViewerPayload>(token, '/user', timeoutMs).then((result) =>
    result.ok ? { ok: true, data: viewerFromPayload(result.data) } : result
  )
}
