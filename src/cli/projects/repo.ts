import type {
  RuntimeRepoList,
  RuntimeRepoSearchRefs
} from '../../shared/runtime-worktree-contracts'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow } from './repo-format'
import { printResult } from '../output/command-result-output'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalRepoKind,
  getRequiredStringFlag
} from '../arguments/flags'
import { resolveRepoPathArgument } from './repo-path-arguments'
import { RuntimeClientError } from '../runtime/connection/types'
import { attachCliErrorData } from '../workspaces/worktree-setup-decision-recovery'
import { resolveHostFlagTarget } from '../hosts/execution-host-flag'

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
    const visibility = getRequiredStringFlag(flags, 'external-worktree-visibility')
    if (visibility !== 'show' && visibility !== 'hide' && visibility !== 'inherit') {
      throw new RuntimeClientError(
        'invalid_argument',
        '--external-worktree-visibility must be show, hide, or inherit.'
      )
    }
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.update', {
      repo,
      updates: { externalWorktreeVisibility: visibility === 'inherit' ? null : visibility }
    })
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
