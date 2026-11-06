import { uncertainBranchDeletion } from '../../shared/standalone-branch-deletion'
import { z } from 'zod'
import { REPO_DELETE_BRANCH_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'
import type { RuntimeRepoList, RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow, printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalRepoKind,
  getRequiredStringFlag
} from '../flags'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime/types'
import { attachCliErrorData } from './worktree-setup-decision-recovery'

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
  'repo set-base-ref': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.setBaseRef', {
      repo: getRequiredStringFlag(flags, 'repo'),
      ref: getRequiredStringFlag(flags, 'ref')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo delete-branch': async ({ flags, client, json }) => {
    const request = {
      repo: getRequiredStringFlag(flags, 'repo'),
      repoHostId: getRequiredStringFlag(flags, 'repo-host-id'),
      ref: getRequiredStringFlag(flags, 'ref'),
      expectedOid: getRequiredStringFlag(flags, 'expected-oid'),
      anchorRef: getRequiredStringFlag(flags, 'anchor-ref'),
      anchorOid: getRequiredStringFlag(flags, 'anchor-oid')
    }
    let dispatched = false
    const result = await client
      .call('repo.deleteBranch', request, {
        requestSelection: {
          paramsForStatus: (raw) => {
            const status = z.object({ capabilities: z.array(z.string()) }).safeParse(raw)
            if (
              !status.success ||
              !status.data.capabilities.includes(REPO_DELETE_BRANCH_RUNTIME_CAPABILITY)
            ) {
              throw new RuntimeClientError(
                'unsupported_operation',
                'Update Orca on the execution host: safe standalone branch deletion is unsupported.'
              )
            }
            return request
          },
          onDispatch: () => {
            dispatched = true
          }
        }
      })
      .catch((error: unknown) => {
        if (
          dispatched &&
          error instanceof RuntimeClientError &&
          ['runtime_unavailable', 'runtime_timeout', 'invalid_runtime_response'].includes(
            error.code
          )
        ) {
          const uncertain = uncertainBranchDeletion(
            `The runtime reply was lost or could not be verified: ${error.message}`
          )
          throw new RuntimeClientError(uncertain.code, uncertain.message, uncertain.data)
        }
        throw error
      })
    printResult(result, json, (value) => JSON.stringify(value))
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
