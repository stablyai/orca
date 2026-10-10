import { createHash } from 'node:crypto'
import type { GitHubRepoExecOptions } from './github-api-repository'

export function githubReadExecutionScope(
  options: GitHubRepoExecOptions,
  environment: NodeJS.ProcessEnv = options.env ?? process.env
): string {
  const { admissionTier: _admissionTier, ...executionOptions } = options
  // gh wrappers and credential selection can depend on cwd and the inherited environment.
  return createHash('sha256')
    .update(
      JSON.stringify([
        executionOptions,
        process.cwd(),
        Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))
      ])
    )
    .digest('hex')
}
