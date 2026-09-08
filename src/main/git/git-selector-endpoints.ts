import type { GitCommandRunner } from '../../shared/git-effective-upstream'
import { gitOperationSelector } from '../../shared/git-operation-selector'
import { parseGitRemoteVerboseLine } from '../../shared/git-remote-url-index'

export type GitSelectorEndpoints = { fetch: string; push: string[] }

export async function captureGitSelectorEndpoints(
  config: Map<string, string>,
  remoteNames: readonly string[],
  runGit: GitCommandRunner,
  urlBudget: number
): Promise<Map<string, GitSelectorEndpoints>> {
  const selectors = new Set<string>()
  for (const [key, raw] of config) {
    if (key === 'remote.pushdefault' || /^branch\..+\.(remote|pushremote)$/.test(key)) {
      const value = raw.trim()
      if (
        value &&
        value !== '.' &&
        gitOperationSelector(value, remoteNames).kind === 'literal-url'
      ) {
        selectors.add(value)
      }
    }
  }
  if (selectors.size * 2 > urlBudget) {
    throw new Error('Git remote topology has too many URLs to resolve safely.')
  }
  const endpoints = new Map<string, GitSelectorEndpoints>()
  // Command-local configuration lets the execution host apply all Git URL rewrites.
  for (const value of selectors) {
    let name = 'orca-operation-selector'
    while (
      remoteNames.includes(name) ||
      [...config.keys()].some((key) => key.startsWith(`remote.${name}.`))
    ) {
      name += '-'
    }
    const { stdout } = await runGit(['-c', `remote.${name}.url=${value}`, 'remote', '-v'])
    const result: GitSelectorEndpoints = { fetch: '', push: [] }
    for (const line of stdout.split(/\r?\n/)) {
      const entry = parseGitRemoteVerboseLine(line)
      if (entry?.name !== name) {
        continue
      }
      if (entry.direction === 'fetch') {
        result.fetch = entry.url
      } else {
        result.push.push(entry.url)
      }
    }
    endpoints.set(value, result)
  }
  return endpoints
}
