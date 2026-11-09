// `GOLDEN_IMAGE_SOURCE=git:<https://github.com/owner/repo>#<branch>`: the golden image's orcad tracks
// that branch's HEAD (cloud features add host RPCs that no upstream release has). Read through the
// GitHub App's installation on that repo with a read-only, single-repo token; nothing is bound to any
// customer account. A new HEAD rebuilds only when it touches code that ships inside the VM.
import { parseGitHubRepo } from './github-app'

export type GitSource = { repoUrl: string; owner: string; repo: string; ref: string }

/** Paths whose changes reach the VM (orcad, the CLI, their packages and build). Renderer-only edits don't. */
const VM_PATHS = [
  /^src\/(main|shared|cli|relay|orcad)\//,
  /^packages\//,
  /^mobile\//,
  /^config\/scripts\/(orcad-distribution|cli-build)\//,
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
  /^config\/tsconfig\.(cli|build\.cli|node)\.json$/
]

export function touchesVm(path: string): boolean {
  return VM_PATHS.some((pattern) => pattern.test(path))
}

export function parseGitSource(source: string | undefined): GitSource | null {
  if (!source?.startsWith('git:')) {
    return null
  }
  const [repoUrl, ref] = source.slice('git:'.length).split('#')
  const parsed = repoUrl ? parseGitHubRepo(repoUrl) : null
  if (!parsed || !ref || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    return null
  }
  return { repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`, ...parsed, ref }
}

export type AppRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Response>

export type SourceHead = {
  sha: string
  /** `Authorization` header value for git over HTTPS (Basic x-access-token), 1 h, contents:read. */
  gitAuthorization: string
  /** Whether HEAD changed VM code since `baseSha`; true when unknown (no base, compare failed). */
  touchesVm: boolean
}

/** HEAD of the source branch plus a read token for the build; null when the App can't read the repo. */
export async function resolveSourceHead(
  app: AppRequest,
  source: GitSource,
  baseSha: string | null,
  doFetch: typeof fetch = fetch
): Promise<SourceHead | null> {
  const installation = await app('GET', `/repos/${source.owner}/${source.repo}/installation`)
  if (!installation.ok) {
    return null
  }
  const { id } = (await installation.json()) as { id: number }
  const minted = await app('POST', `/app/installations/${id}/access_tokens`, {
    repositories: [source.repo],
    permissions: { contents: 'read', metadata: 'read' }
  })
  if (!minted.ok) {
    return null
  }
  const { token } = (await minted.json()) as { token: string }
  const api = (path: string) =>
    doFetch(`https://api.github.com/repos/${source.owner}/${source.repo}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'orca-sandbox-control'
      }
    })
  const head = await api(`/commits/${encodeURIComponent(source.ref)}`)
  if (!head.ok) {
    return null
  }
  const sha = String(((await head.json()) as { sha?: string }).sha ?? '')
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return null
  }
  let changed = true
  if (baseSha && baseSha !== sha) {
    const compare = await api(`/compare/${baseSha}...${sha}`)
    if (compare.ok) {
      const body = (await compare.json()) as { files?: { filename: string }[]; status?: string }
      // GitHub caps the file list at 300; a capped list counts as touching the VM.
      changed = !body.files || body.files.length >= 300 || body.files.some((f) => touchesVm(f.filename))
    }
  } else if (baseSha === sha) {
    changed = false
  }
  return { sha, gitAuthorization: `Basic ${btoa(`x-access-token:${token}`)}`, touchesVm: changed }
}
