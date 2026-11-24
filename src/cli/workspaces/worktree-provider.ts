import type { CommandHandler } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { getRequiredWorktreeSelector } from '../workspace-selection/workspace-selector'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  parseCliAgent,
  readCliAgentLaunch
} from '../agents/agent-launch-request'
import { printResult } from '../output/command-result-output'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { AgentLaunchResult } from '../../shared/agent-launch/contracts/agent-launch-intent'
import {
  callProviderList,
  reportDiagnostics,
  resolveProviderRepo,
  type AcquireResult,
  type ReleaseResult
} from './worktree-provider-shared'

const DEFAULT_RELEASE_CLIENT_TIMEOUT_MS = 330_000

function formatAcquire(
  value: AcquireResult & { launch?: AgentLaunchResult & { operationId?: string } }
): string {
  const lease = value.claim.leaseId ? `, lease ${value.claim.leaseId}` : ''
  const profile = value.claim.profile ? `, profile ${value.claim.profile}` : ''
  const setup = value.setup.ran
    ? 'provider setup ran'
    : 'no provider setup; repo setup hooks do not run for provider-acquired workspaces'
  const lines = [
    `worktree: ${value.worktree.id}`,
    `path: ${value.worktree.path}`,
    `provider: ${value.claim.name}${profile}${lease}`,
    `setup: ${setup}`,
    `release: orca worktree release ${value.worktree.id}`
  ]
  if (value.launch) {
    lines.push(formatAgentLaunch(value.launch))
  }
  return lines.join('\n')
}

function formatRelease(value: ReleaseResult): string {
  return [
    `released: ${value.forgotten ? 'unregistered (lease may still be held)' : 'true'}`,
    `provider: ${value.provider}`
  ].join('\n')
}

async function acquireWorktree(context: Parameters<CommandHandler>[0]): Promise<void> {
  const { flags, client, cwd, json, rawArgs } = context
  const providerName = getRequiredStringFlag(flags, 'provider')
  const repo = await resolveProviderRepo(flags, cwd, client)
  const listed = await callProviderList(client, repo)
  reportDiagnostics(listed.result.diagnostics, json)
  const matches = listed.result.providers.filter((entry) => entry.name === providerName)
  if (matches.length > 1) {
    throw new RuntimeClientError(
      'worktree_provider_config_conflict',
      `Provider "${providerName}" is defined in both user config and the repository orca.yaml. Remove one definition before acquiring.`
    )
  }
  const provider = matches[0]
  if (!provider) {
    throw new RuntimeClientError(
      'worktree_provider_not_configured',
      `Unknown worktree provider "${providerName}".${
        listed.result.providers.length > 0
          ? ` Configured providers: ${listed.result.providers.map((entry) => entry.name).join(', ')}.`
          : ' No worktree providers are configured on this host.'
      }`,
      {
        nextSteps: [
          'Add it to ~/.orca/worktree-providers.yaml, or define it in the repository orca.yaml.',
          'Run `orca worktree providers list` to inspect the host configuration.'
        ]
      }
    )
  }
  if (!provider.trusted) {
    throw new RuntimeClientError(
      'worktree_provider_untrusted',
      `Provider "${providerName}" comes from the repository orca.yaml and is not trusted on this host.`,
      {
        nextSteps: [
          `Review its commands with \`orca worktree providers list --repo ${repo}\`.`,
          `Then run \`orca worktree providers trust --repo ${repo}\`.`
        ]
      }
    )
  }
  const profile = getOptionalStringFlag(flags, 'profile')
  const agentFlag = getOptionalStringFlag(flags, 'agent')
  // Validate the launch request before claiming, so a bad --agent/--model cannot strand a slot.
  const launchRequest = agentFlag
    ? readCliAgentLaunch(flags, parseCliAgent(agentFlag), { createsWorktree: false })
    : undefined
  const acquired = await client.call<AcquireResult>(
    'worktree.acquire',
    {
      repo,
      provider: providerName,
      ...(profile ? { profile } : {})
    },
    {
      // Claim and setup each get the provider timeout; teardown and launch are separate calls.
      timeoutMs: provider.timeoutSeconds * 1000 * (provider.setup ? 2 : 1) + 30_000
    }
  )

  let launch: Awaited<ReturnType<typeof callAgentLaunch>> | undefined
  if (launchRequest) {
    try {
      const capabilities = (await getAgentLaunchCapabilities(client)) ?? []
      launch = await callAgentLaunch(
        client,
        launchRequest,
        {
          target: {
            kind: 'existing',
            worktree: `id:${acquired.result.worktree.id}`
          }
        },
        capabilities,
        rawArgs
      )
    } catch (error) {
      const released = await client
        .call<ReleaseResult>(
          'worktree.release',
          { worktree: `id:${acquired.result.worktree.id}` },
          { timeoutMs: acquired.result.claim.timeoutSeconds * 1000 + 60_000 }
        )
        .then(
          () => true,
          () => false
        )
      throw new RuntimeClientError(
        'worktree_provider_acquire_launch_failed',
        `Agent launch failed: ${error instanceof Error ? error.message : String(error)} ${
          released
            ? 'The acquired worktree was released.'
            : `The worktree is still acquired; release it with \`orca worktree release ${acquired.result.worktree.id}\`.`
        }`,
        {
          nextSteps: released
            ? ['Retry `orca worktree acquire` once the agent launch problem is fixed.']
            : [`Run \`orca worktree release ${acquired.result.worktree.id}\` to return the slot.`]
        }
      )
    }
  }

  const result = launch ? { ...acquired.result, launch: launch.result } : acquired.result
  printResult({ ...acquired, result }, json, formatAcquire)
}

async function releaseWorktree(context: Parameters<CommandHandler>[0]): Promise<void> {
  const { flags, client, cwd, json } = context
  const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
  const force = flags.get('force') === true
  const forget = flags.get('forget') === true
  if (force && forget) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --force (discard changes through the provider) or --forget (unregister without the provider).'
    )
  }
  let timeoutMs = DEFAULT_RELEASE_CLIENT_TIMEOUT_MS
  try {
    const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree
    })
    const provider = shown.result.worktree.worktreeProvider
    if (!provider) {
      throw new RuntimeClientError(
        'worktree_provider_not_managed',
        `Workspace ${shown.result.worktree.id} is not managed by a worktree provider. ` +
          'Use `orca worktree rm` only if Orca created the checkout.'
      )
    }
    timeoutMs = provider.timeoutSeconds * 1000 + 60_000
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw error
    }
    // A vanished checkout no longer resolves through show; a full id: selector still releases it.
  }
  const result = await client.call<ReleaseResult>(
    'worktree.release',
    { worktree, force, forget },
    { timeoutMs }
  )
  if (!json && result.result.warning) {
    console.error(result.result.warning)
  }
  printResult(result, json, formatRelease)
}

export const WORKTREE_PROVIDER_HANDLERS: Record<string, CommandHandler> = {
  'worktree acquire': acquireWorktree,
  'worktree release': releaseWorktree
}
