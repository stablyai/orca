import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostedReviewProvider } from '../../shared/hosted-review'

const PULL_REQUEST_TEMPLATE_CANDIDATES = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.azuredevops/pull_request_template.md',
  '.azuredevops/PULL_REQUEST_TEMPLATE.md',
  '.gitea/pull_request_template.md',
  '.gitea/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md'
]

const MERGE_REQUEST_TEMPLATE_CANDIDATES = [
  '.gitlab/merge_request_templates/Default.md',
  '.gitlab/merge_request_templates/default.md',
  '.gitlab/merge_request_template.md',
  '.gitlab/MERGE_REQUEST_TEMPLATE.md'
]

function getTemplateCandidates(provider?: HostedReviewProvider | null): string[] {
  if (provider === 'gitlab') {
    return [...MERGE_REQUEST_TEMPLATE_CANDIDATES, ...PULL_REQUEST_TEMPLATE_CANDIDATES]
  }
  return PULL_REQUEST_TEMPLATE_CANDIDATES
}

export async function readHostedPullRequestTemplate(
  repoPath: string,
  connectionId?: string | null
): Promise<string> {
  return readHostedReviewTemplate(repoPath, connectionId)
}

export async function readHostedReviewTemplate(
  repoPath: string,
  connectionId?: string | null,
  provider?: HostedReviewProvider | null
): Promise<string> {
  if (connectionId) {
    return ''
  }
  for (const relativeCandidate of getTemplateCandidates(provider)) {
    try {
      return await readFile(join(repoPath, relativeCandidate), 'utf8')
    } catch {
      // Try the next conventional hosted-review template path.
    }
  }
  return ''
}

export async function resolveHostedReviewBodyForGeneration(args: {
  body: string
  repoPath: string
  connectionId?: string | null
  provider?: HostedReviewProvider | null
  useTemplate?: boolean
}): Promise<string> {
  if (!args.useTemplate || args.body.trim()) {
    return args.body
  }
  // Generated bodies bypass provider template fallback; include the requested template in AI context first.
  return readHostedReviewTemplate(args.repoPath, args.connectionId, args.provider)
}
