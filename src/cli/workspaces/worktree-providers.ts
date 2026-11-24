import type { CommandHandler } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import {
  callProviderList,
  formatArgv,
  reportDiagnostics,
  resolveProviderRepo,
  type ProviderListResult
} from './worktree-provider-shared'

function formatProviders(result: ProviderListResult): string {
  if (result.providers.length === 0) {
    return 'No worktree providers configured.'
  }
  return result.providers
    .map((provider) => {
      const trust =
        provider.source === 'repo' ? (provider.trusted ? ', trusted' : ', untrusted') : ''
      const lines = [
        `${provider.name} (${provider.source}${trust})`,
        `  claim: ${formatArgv(provider.claim)}`,
        `  release: ${formatArgv(provider.release)}`,
        ...(provider.status ? [`  status: ${formatArgv(provider.status)}`] : []),
        ...(provider.setup ? [`  setup: ${formatArgv(provider.setup)}`] : []),
        `  timeout: ${provider.timeoutSeconds}s, cwd: ${provider.workingDirectory}`
      ]
      return lines.join('\n')
    })
    .join('\n')
}

async function listProviders(context: Parameters<CommandHandler>[0]): Promise<void> {
  const { flags, client, cwd, json } = context
  const repo = await resolveProviderRepo(flags, cwd, client)
  const result = await callProviderList(client, repo)
  reportDiagnostics(result.result.diagnostics, json)
  printResult(result, json, formatProviders)
}

async function trustProviders(context: Parameters<CommandHandler>[0]): Promise<void> {
  const { flags, client, cwd, json } = context
  const repo = await resolveProviderRepo(flags, cwd, client)
  const listed = await callProviderList(client, repo)
  reportDiagnostics(listed.result.diagnostics, json)
  const repoProviders = listed.result.providers.filter((entry) => entry.source === 'repo')
  if (repoProviders.length === 0) {
    throw new RuntimeClientError(
      'worktree_provider_config_missing',
      'The repository orca.yaml has no worktree providers to trust.'
    )
  }
  if (!listed.result.repoConfigHash) {
    throw new RuntimeClientError(
      'worktree_provider_config_missing',
      'Orca could not hash the repository provider config. Check orca.yaml and retry.'
    )
  }
  if (!json) {
    console.log(
      repoProviders
        .map(
          (entry) =>
            `${entry.name}\n  claim: ${formatArgv(entry.claim)}\n  release: ${formatArgv(entry.release)}${
              entry.setup ? `\n  setup: ${formatArgv(entry.setup)}` : ''
            }`
        )
        .join('\n')
    )
  }
  const result = await client.call<{ trusted: true; configHash: string; providers: string[] }>(
    'worktree.providers.trust',
    { repo, expectedConfigHash: listed.result.repoConfigHash }
  )
  printResult(result, json, (value) =>
    [
      `trusted: true`,
      `providers: ${value.providers.join(', ')}`,
      `config: ${value.configHash}`
    ].join('\n')
  )
}

export const WORKTREE_PROVIDERS_HANDLERS: Record<string, CommandHandler> = {
  'worktree providers list': listProviders,
  'worktree providers trust': trustProviders
}
