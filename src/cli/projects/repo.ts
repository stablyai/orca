import type {
  RuntimeRepoList,
  RuntimeRepoSearchRefs
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow } from './repo-format'
import { printResult } from '../output/command-result-output'
import type { BrowserProfileListResult } from '../../shared/browser/runtime/runtime-browser-contracts'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalRepoKind,
  getOptionalStringFlag,
  getOptionalStringFlagAllowingEmpty,
  getRequiredStringFlag
} from '../arguments/flags'
import { resolveRepoPathArgument } from './repo-path-arguments'
import { RuntimeClientError } from '../runtime/connection/types'
import { attachCliErrorData } from '../workspaces/worktree-setup-decision-recovery'
import { resolveHostFlagTarget } from '../hosts/execution-host-flag'
import type { Repo } from '../../shared/repository/repo-types'
import { getRepoSetupAgentStartupPolicy } from '../../shared/workspace-setup/repo-hook-settings-defaults'

/** `inherit` clears the pick; anything else must name a profile on the repo's Orca host. */
async function resolveBrowserProfileFlag(
  client: HandlerContext['client'],
  value: string
): Promise<string | null> {
  if (value === 'inherit') {
    return null
  }
  const { profiles } = (await client.call<BrowserProfileListResult>('browser.profileList')).result
  if (!profiles.some((profile) => profile.id === value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Browser profile ${value} was not found. Run \`orca tab profile list\` to see profile ids.`
    )
  }
  return value
}

function getOptionalChoiceFlag<const T extends string>(
  flags: Map<string, string | boolean>,
  name: string,
  choices: readonly T[]
): T | undefined {
  // An empty value is an error, not an omitted flag, so it cannot be skipped silently.
  const value = getOptionalStringFlagAllowingEmpty(flags, name)
  if (value === undefined) {
    return undefined
  }
  const choice = choices.find((entry) => entry === value)
  if (choice !== undefined) {
    return choice
  }
  const listed =
    choices.length === 2
      ? choices.join(' or ')
      : `${choices.slice(0, -1).join(', ')}, or ${choices.at(-1)}`
  throw new RuntimeClientError('invalid_argument', `--${name} must be ${listed}.`)
}

type RepoSetResultRow = Record<string, unknown> &
  Pick<Repo, 'browserProfileId' | 'hookSettings' | 'workspaceCleanupPolicy'>

type RepoSetSetting = {
  saved: string
  unsupported?: string
  requested: boolean
  applied: boolean
}

function listPhrases(phrases: string[]): string {
  return phrases.length < 3
    ? phrases.join(' and ')
    : `${phrases.slice(0, -1).join(', ')}, and ${phrases.at(-1)}`
}

function assertRepoSetSaved(settings: RepoSetSetting[]): void {
  const requested = settings.filter((setting) => setting.requested)
  const dropped = requested.filter((setting) => !setting.applied)
  if (dropped.length === 0) {
    return
  }
  const saved = requested.filter((setting) => setting.applied).map((setting) => setting.saved)
  const savedClause =
    saved.length === 0
      ? ''
      : `, so only ${listPhrases(saved)} ${saved.length === 1 ? 'was' : 'were'} saved`
  throw new RuntimeClientError(
    'incompatible_runtime',
    `This Orca host does not support ${listPhrases(dropped.map((setting) => setting.unsupported ?? setting.saved))}${savedClause}. Update Orca on that host.`
  )
}

async function setRepoHidden(
  { flags, client, json }: Pick<HandlerContext, 'flags' | 'client' | 'json'>,
  hidden: boolean
): Promise<void> {
  const host = await resolveHostFlagTarget(flags, client)
  const result = await client.call<{ repo: Record<string, unknown> }>('repo.setHidden', {
    repo: getRequiredStringFlag(flags, 'repo'),
    hidden,
    ...(host ? { repoHostId: host.id } : {})
  })
  printResult(result, json, formatRepoShow)
}

export const REPO_HANDLERS: Record<string, CommandHandler> = {
  'repo list': async ({ client, json }) => {
    const result = await client.call<RuntimeRepoList>('repo.list')
    printResult(result, json, formatRepoList)
  },
  'repo add': async ({ flags, client, cwd, json }) => {
    const repoPath = getRequiredStringFlag(flags, 'path')
    const kind = getOptionalRepoKind(flags)
    const result = await client
      .call<{ repo: Record<string, unknown> }>('repo.add', {
        path: resolveRepoPathArgument(repoPath, cwd, client.isRemote, 'Remote repo add'),
        ...(kind === undefined ? {} : { kind })
      })
      .catch((error: unknown) => {
        if (
          error instanceof RuntimeClientError &&
          kind !== 'folder' &&
          error.message.startsWith('Not a valid git repository:')
        ) {
          throw attachCliErrorData(error, {
            ...(error.data && typeof error.data === 'object' ? error.data : {}),
            nextSteps: [
              'This directory is not itself a Git repository (for example, a parent folder of separate Git repositories). To open it as a folder workspace without Git worktrees or source control, rerun this command with --kind folder.'
            ]
          })
        }
        throw error
      })
    printResult(result, json, formatRepoShow)
  },
  'repo show': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
      repo: getRequiredStringFlag(flags, 'repo')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo set': async ({ flags, client, json }) => {
    const repo = getRequiredStringFlag(flags, 'repo')
    const visibility = getOptionalChoiceFlag(flags, 'external-worktree-visibility', [
      'show',
      'hide',
      'inherit'
    ])
    const browserProfile = getOptionalStringFlag(flags, 'browser-profile')
    const setupAgentStartup = getOptionalChoiceFlag(flags, 'setup-agent-startup', [
      'wait-for-setup',
      'start-immediately'
    ])
    const workspaceCleanup = getOptionalChoiceFlag(flags, 'workspace-cleanup', ['off', 'inherit'])
    if (
      visibility === undefined &&
      browserProfile === undefined &&
      setupAgentStartup === undefined &&
      workspaceCleanup === undefined
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass --external-worktree-visibility, --browser-profile, --setup-agent-startup, or --workspace-cleanup.'
      )
    }
    const browserProfileId =
      browserProfile === undefined
        ? undefined
        : await resolveBrowserProfileFlag(client, browserProfile)
    const result = await client.call<{ repo: RepoSetResultRow }>('repo.update', {
      repo,
      updates: {
        ...(visibility === undefined
          ? {}
          : { externalWorktreeVisibility: visibility === 'inherit' ? null : visibility }),
        ...(browserProfileId === undefined ? {} : { browserProfileId }),
        ...(setupAgentStartup === undefined ? {} : { setupAgentStartupPolicy: setupAgentStartup }),
        ...(workspaceCleanup === undefined
          ? {}
          : { workspaceCleanupPolicy: workspaceCleanup === 'off' ? { mode: 'off' } : null })
      }
    })
    const row = result.result.repo
    // A host from before a setting drops its field and still answers with its row.
    assertRepoSetSaved([
      { saved: 'the worktree visibility', requested: visibility !== undefined, applied: true },
      {
        saved: 'the browser profile',
        unsupported: 'per-repo browser profiles',
        requested: browserProfileId !== undefined,
        applied: (row.browserProfileId ?? null) === browserProfileId
      },
      {
        saved: 'the agent startup policy',
        unsupported: 'per-repo agent startup policies',
        requested: setupAgentStartup !== undefined,
        applied: getRepoSetupAgentStartupPolicy(row) === setupAgentStartup
      },
      {
        saved: 'the workspace cleanup setting',
        unsupported: 'per-repo workspace cleanup',
        requested: workspaceCleanup !== undefined,
        applied: (row.workspaceCleanupPolicy?.mode ?? 'inherit') === workspaceCleanup
      }
    ])
    printResult(result, json, formatRepoShow)
  },
  'repo hide': (context) => setRepoHidden(context, true),
  'repo unhide': (context) => setRepoHidden(context, false),
  'repo set-base-ref': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.setBaseRef', {
      repo: getRequiredStringFlag(flags, 'repo'),
      ref: getRequiredStringFlag(flags, 'ref')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo search-refs': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeRepoSearchRefs>('repo.searchRefs', {
      repo: getRequiredStringFlag(flags, 'repo'),
      query: getRequiredStringFlag(flags, 'query'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatRepoRefs)
  }
}
