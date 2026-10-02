import type { RuntimeRepoList, RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow, printResult } from '../format'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../flags'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime/types'

/** Keeps visibility owned by the selected runtime; inherit clears only the repo override. */
async function setRepoWorktreeVisibility({ flags, client, json }: HandlerContext): Promise<void> {
  const repo = getRequiredStringFlag(flags, 'repo')
  const visibility = getRequiredStringFlag(flags, 'external')
  if (visibility !== 'show' && visibility !== 'hide' && visibility !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--external must be show, hide, or inherit.')
  }
  const result = await client.call<{ repo: Record<string, unknown> }>('repo.update', {
    repo,
    updates: { externalWorktreeVisibility: visibility === 'inherit' ? null : visibility }
  })
  printResult(result, json, formatRepoShow)
}

export const REPO_HANDLERS: Record<string, CommandHandler> = {
  'repo set-worktree-visibility': setRepoWorktreeVisibility,
  'repo list': async ({ client, json }) => {
    const result = await client.call<RuntimeRepoList>('repo.list')
    printResult(result, json, formatRepoList)
  },
  'repo add': async ({ flags, client, cwd, json }) => {
    const repoPath = getRequiredStringFlag(flags, 'path')
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.add', {
      path: resolveRepoPathArgument(repoPath, cwd, client.isRemote, 'Remote repo add')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo show': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
      repo: getRequiredStringFlag(flags, 'repo')
    })
    printResult(result, json, formatRepoShow)
  },
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
