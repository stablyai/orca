import type { RuntimeRepoList, RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import type { RepoKind } from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow, printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime-client'

function getOptionalRepoKind(flags: Map<string, string | boolean>): RepoKind | undefined {
  const kind = getOptionalStringFlag(flags, 'kind')
  if (kind === undefined) {
    return undefined
  }
  if (kind === 'git' || kind === 'folder') {
    return kind
  }
  throw new RuntimeClientError('invalid_argument', '--kind must be git or folder')
}

export const REPO_HANDLERS: Record<string, CommandHandler> = {
  'repo list': async ({ client, json }) => {
    const result = await client.call<RuntimeRepoList>('repo.list')
    printResult(result, json, formatRepoList)
  },
  'repo add': async ({ flags, client, cwd, json }) => {
    const repoPath = getRequiredStringFlag(flags, 'path')
    const kind = getOptionalRepoKind(flags)
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.add', {
      path: resolveRepoPathArgument(repoPath, cwd, client.isRemote, 'Remote repo add'),
      // Why: GUI already registers folder projects; CLI default remains git (#13358).
      ...(kind ? { kind } : {})
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
