// Main and detached renewer must derive the same holder key from one environment contract.

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
