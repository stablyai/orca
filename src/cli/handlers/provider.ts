import type { CommandHandler } from '../dispatch'
import type {
  WorkspaceProviderListResult,
  WorkspaceProviderListing
} from '../../shared/recipe-workspace-create-progress'
import {
  formatWorkspaceProviderTarget,
  parseWorkspaceTarget
} from '../../shared/workspace-provider-target'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { assertProviderHost } from './worktree-create-provider'

function formatListing(provider: WorkspaceProviderListing): string {
  const destroy = provider.capabilities.destroy ? 'destroys on removal' : 'no destroy step'
  const timeouts = provider.timeoutSeconds
    ? Object.entries(provider.timeoutSeconds)
        .map(([step, seconds]) => `${step} ${seconds}s`)
        .join(', ')
    : ''
  return [
    `${provider.target}  ${provider.name}  [${provider.checkoutMode}; ${destroy}${timeouts ? `; timeouts ${timeouts}` : ''}]${provider.available ? '' : `  unavailable: ${provider.unavailableReason ?? 'unknown'}`}`,
    ...(provider.description ? [`    ${provider.description}`] : [])
  ].join('\n')
}

export function formatProviderList(result: WorkspaceProviderListResult): string {
  if (result.providers.length === 0 && result.diagnostics.length === 0) {
    return 'No workspace providers. Add environmentRecipes to a repo orca.yaml, or install a plugin that provides recipes.'
  }
  const lines: string[] = []
  const repos = new Map<string, WorkspaceProviderListing[]>()
  for (const provider of result.providers) {
    const key = `${provider.repo.name} (${provider.repo.path})`
    repos.set(key, [...(repos.get(key) ?? []), provider])
  }
  for (const [repo, providers] of repos) {
    lines.push(
      repo,
      ...providers.map((provider) => `  ${formatListing(provider).replaceAll('\n', '\n  ')}`)
    )
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(
      `warning: ${diagnostic.repoId} environmentRecipes[${diagnostic.index}]${diagnostic.field ? `.${diagnostic.field}` : ''}: ${diagnostic.message}`
    )
  }
  return lines.join('\n')
}

function readTarget(flags: Map<string, string | boolean>): string {
  const raw = getOptionalStringFlag(flags, 'target')
  if (!raw) {
    throw new RuntimeClientError('invalid_argument', 'Name a provider target, e.g. recipe:<id>.', {
      field: 'target'
    })
  }
  let parsed: ReturnType<typeof parseWorkspaceTarget>
  try {
    parsed = parseWorkspaceTarget(raw)
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      error instanceof Error ? error.message : String(error),
      {
        field: 'target'
      }
    )
  }
  if (parsed.kind !== 'provider') {
    throw new RuntimeClientError(
      'invalid_argument',
      `${raw} is a host, not a provider. Providers look like recipe:<id> or plugin:<plugin>/<id>; see \`orca provider list\`.`,
      { field: 'target' }
    )
  }
  return formatWorkspaceProviderTarget(parsed.target)
}

export const PROVIDER_HANDLERS: Record<string, CommandHandler> = {
  'provider list': async ({ flags, client, json }) => {
    await assertProviderHost(client)
    const repo = getOptionalStringFlag(flags, 'repo')
    const result = await client.call<WorkspaceProviderListResult>(
      'provider.list',
      repo ? { repo } : {}
    )
    printResult(result, json, formatProviderList)
  },
  'provider show': async ({ flags, client, json }) => {
    const target = readTarget(flags)
    await assertProviderHost(client)
    const repo = getOptionalStringFlag(flags, 'repo')
    const listed = await client.call<WorkspaceProviderListResult>(
      'provider.list',
      repo ? { repo } : {}
    )
    const providers = listed.result.providers.filter((provider) => provider.target === target)
    if (providers.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `No provider ${target}${repo ? ` for ${repo}` : ''}. Run \`orca provider list\` to see the valid targets.`,
        {
          field: 'target',
          target,
          valid: [...new Set(listed.result.providers.map((provider) => provider.target))]
        }
      )
    }
    printResult({ ...listed, result: { ...listed.result, providers } }, json, formatProviderList)
  }
}
