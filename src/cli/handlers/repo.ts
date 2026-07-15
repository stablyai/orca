import type { RuntimeRepoList, RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import { normalizeRepoBadgeColor } from '../../shared/repo-badge-color'
import type { CommandHandler } from '../dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow, printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { resolveProjectGroup } from '../project-group-selector'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime-client'

export const REPO_HANDLERS: Record<string, CommandHandler> = {
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
  'repo set': async ({ flags, client, json }) => {
    const repo = getRequiredStringFlag(flags, 'repo')
    const groupSelector = getOptionalStringFlag(flags, 'group')
    const ungroup = flags.get('ungroup') === true
    if (groupSelector !== undefined && ungroup) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass either --group or --ungroup, not both.'
      )
    }
    const updates: Record<string, unknown> = {}
    if (groupSelector !== undefined) {
      updates.projectGroupId = (await resolveProjectGroup(client, groupSelector)).id
    }
    if (ungroup) {
      updates.projectGroupId = null
    }
    const displayName = getOptionalStringFlag(flags, 'display-name')
    if (displayName !== undefined) {
      updates.displayName = displayName
    }
    const badgeColor = getOptionalStringFlag(flags, 'badge-color')
    if (badgeColor !== undefined) {
      // Why: the store silently drops an unnormalizable badge color, so an
      // invalid value must fail here instead of reporting a no-op success.
      const normalized = normalizeRepoBadgeColor(badgeColor)
      if (normalized === null) {
        throw new RuntimeClientError(
          'invalid_argument',
          `Invalid --badge-color "${badgeColor}". Pass a hex color like #ff8800.`
        )
      }
      updates.badgeColor = normalized
    }
    if (Object.keys(updates).length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass at least one of --group, --ungroup, --display-name, --badge-color.'
      )
    }
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.update', {
      repo,
      updates
    })
    printResult(result, json, formatRepoShow)
  },
  'repo rm': async ({ flags, client, json }) => {
    const repo = getRequiredStringFlag(flags, 'repo')
    const result = await client.call<{ removed: boolean }>('repo.rm', { repo })
    // Why: a runtime that reports removed: false must not read as success.
    if (!result.result.removed) {
      throw new RuntimeClientError('selector_not_found', `Repo ${repo} is not registered.`)
    }
    printResult(result, json, () => `Removed repo registration for ${repo}.`)
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
