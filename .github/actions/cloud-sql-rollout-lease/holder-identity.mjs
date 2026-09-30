// Who we claim to be on the lease object. Shared by main and the detached renewer so both agree
// on the holder key without re-deriving it from a different set of environment variables.

export function holderIdentity(explicitHolderKey) {
  const repository = process.env.GITHUB_REPOSITORY ?? 'unknown'
  const runId = process.env.GITHUB_RUN_ID ?? 'unknown'
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const holderKey = explicitHolderKey || `${repository}/${runId}`
  if (/[\r\n]/.test(holderKey)) {
    throw new Error('holder-key must be single-line')
  }
  return {
    holderKey,
    repository,
    workflow: process.env.GITHUB_WORKFLOW ?? 'unknown',
    runId,
    runUrl: `${server}/${repository}/actions/runs/${runId}`,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? 'unknown'
  }
}
