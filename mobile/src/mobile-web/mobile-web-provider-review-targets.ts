export function githubProviderReviewTarget(details: unknown): { prRepo?: Record<string, string> } {
  const item = providerDetailItem(details)
  const prRepo = item && isRecord(item.prRepo) ? item.prRepo : null
  if (!prRepo || !nonemptyString(prRepo.owner) || !nonemptyString(prRepo.repo)) {
    return {}
  }
  return {
    prRepo: {
      owner: prRepo.owner,
      repo: prRepo.repo,
      ...(nonemptyString(prRepo.host) ? { host: prRepo.host } : {})
    }
  }
}

export function gitLabProviderReviewTarget(details: unknown): {
  projectRef?: Record<string, string>
} {
  const item = providerDetailItem(details)
  const projectRef = item && isRecord(item.projectRef) ? item.projectRef : null
  if (!projectRef || !nonemptyString(projectRef.host) || !nonemptyString(projectRef.path)) {
    return {}
  }
  return { projectRef: { host: projectRef.host, path: projectRef.path } }
}

export function gitLabProviderReviewPosition(
  details: unknown,
  expectedHead: string
): { baseSha: string; startSha: string; headSha: string } | null {
  if (!isRecord(details)) {
    return null
  }
  const headSha = boundedHead(details.headSha)
  const baseSha = boundedHead(details.baseSha)
  const startSha = boundedHead(details.startSha)
  return headSha === expectedHead && baseSha && startSha ? { baseSha, startSha, headSha } : null
}

function providerDetailItem(details: unknown): Record<string, unknown> | null {
  return isRecord(details) && isRecord(details.item) ? details.item : null
}

function boundedHead(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
