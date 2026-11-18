import type {
  RuntimeRepoList,
  RuntimeRepoSearchRefs
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow } from './repo-format'
import { formatProjectGroupList } from './project-format'
import { listProjectGroups, resolveProjectGroupSelector } from './project-group-selector'
import { printResult } from '../output/command-result-output'
import type { BrowserProfileListResult } from '../../shared/browser/runtime/runtime-browser-contracts'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalRepoKind,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { resolveRepoPathArgument } from './repo-path-arguments'
import { RuntimeClientError } from '../runtime/connection/types'
import { attachCliErrorData } from '../workspaces/worktree-setup-decision-recovery'
import { resolveHostFlagTarget } from '../hosts/execution-host-flag'

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

type RepoResult = { repo: Record<string, unknown> }

function moveRepoToProjectGroup(
  client: HandlerContext['client'],
  repo: string,
  groupId: string | null,
  connectionId?: string | null
): Promise<RuntimeRpcSuccess<RepoResult>> {
  return client.call<RepoResult>('projectGroup.moveProject', {
    repo,
    groupId,
    ...(connectionId === undefined ? {} : { connectionId })
  })
}

export const REPO_HANDLERS: Record<string, CommandHandler> = {
  'repo list': async ({ client, json }) => {
    const result = await client.call<RuntimeRepoList>('repo.list')
    printResult(result, json, formatRepoList)
  },
  'repo group list': async ({ client, json }) => {
    printResult(await listProjectGroups(client), json, formatProjectGroupList)
  },
  'repo add': async ({ flags, client, cwd, json }) => {
    const repoPath = getRequiredStringFlag(flags, 'path')
    const kind = getOptionalRepoKind(flags)
    const groupSelector = getOptionalStringFlag(flags, 'project-group')
    // Resolve first so a bad group name refuses before the repo is registered.
    const groupId =
      groupSelector === undefined
        ? undefined
        : await resolveProjectGroupSelector(client, groupSelector)
    const added = await client
      .call<RepoResult>('repo.add', {
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
    if (groupId === undefined) {
      printResult(added, json, formatRepoShow)
      return
    }
    const repoId = String(added.result.repo.id)
    // repo.add never registers an SSH row; null keeps an SSH twin with the same id out of the move.
    const moved = await moveRepoToProjectGroup(client, `id:${repoId}`, groupId, null).catch(
      (error: unknown) => {
        if (error instanceof RuntimeClientError) {
          throw attachCliErrorData(error, {
            ...(error.data && typeof error.data === 'object' ? error.data : {}),
            addedRepoId: repoId,
            nextSteps: [
              `The repo was added but not moved into the project group. Retry with: orca repo set --repo id:${repoId} --project-group ${groupId ?? 'none'}`
            ]
          })
        }
        throw error
      }
    )
    printResult(moved, json, formatRepoShow)
  },
  'repo show': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
      repo: getRequiredStringFlag(flags, 'repo')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo set': async ({ flags, client, json }) => {
    const repo = getRequiredStringFlag(flags, 'repo')
    const visibility = getOptionalStringFlag(flags, 'external-worktree-visibility')
    const browserProfile = getOptionalStringFlag(flags, 'browser-profile')
    const groupSelector = getOptionalStringFlag(flags, 'project-group')
    if (visibility === undefined && browserProfile === undefined && groupSelector === undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass --external-worktree-visibility, --browser-profile or --project-group.'
      )
    }
    if (
      visibility !== undefined &&
      visibility !== 'show' &&
      visibility !== 'hide' &&
      visibility !== 'inherit'
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--external-worktree-visibility must be show, hide, or inherit.'
      )
    }
    const browserProfileId =
      browserProfile === undefined
        ? undefined
        : await resolveBrowserProfileFlag(client, browserProfile)
    const groupId =
      groupSelector === undefined
        ? undefined
        : await resolveProjectGroupSelector(client, groupSelector)
    let result: RuntimeRpcSuccess<RepoResult> | null = null
    if (visibility !== undefined || browserProfileId !== undefined) {
      result = await client.call<RepoResult>('repo.update', {
        repo,
        updates: {
          ...(visibility === undefined
            ? {}
            : { externalWorktreeVisibility: visibility === 'inherit' ? null : visibility }),
          ...(browserProfileId === undefined ? {} : { browserProfileId })
        }
      })
      // A host from before per-repo browser profiles drops the field and still answers with its row.
      if (
        browserProfileId !== undefined &&
        (result.result.repo.browserProfileId ?? null) !== browserProfileId
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          visibility === undefined
            ? 'This Orca host does not support per-repo browser profiles. Update Orca on that host.'
            : 'This Orca host does not support per-repo browser profiles, so only the worktree visibility was saved. Update Orca on that host.'
        )
      }
    }
    if (groupId !== undefined) {
      result = await moveRepoToProjectGroup(client, repo, groupId)
    }
    if (result) {
      printResult(result, json, formatRepoShow)
    }
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
