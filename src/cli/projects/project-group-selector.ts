import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import { normalizeTypedName } from '../../shared/text/typed-name-normalization'
import { RuntimeClientError } from '../runtime/connection/types'

const LIST_HINT = 'Run `orca project group list` to see group ids and names.'

/**
 * Resolves `--group` to one listed group: `id:`/`name:` pick the kind, a bare value tries the id
 * first. Resolving here matters because the host files a move to an unknown id as "no group".
 */
export function findProjectGroup(
  groups: readonly ProjectGroup[],
  selector: string,
  flag = 'group'
): ProjectGroup {
  const trimmed = selector.trim()
  const forcedName = trimmed.startsWith('name:')
  const forcedId = trimmed.startsWith('id:')
  const value = forcedName ? trimmed.slice('name:'.length) : forcedId ? trimmed.slice(3) : trimmed
  if (!forcedName) {
    const byId = groups.find((group) => group.id === value)
    if (byId) {
      return byId
    }
  }
  const named = forcedId
    ? []
    : groups.filter((group) => normalizeTypedName(group.name) === normalizeTypedName(value))
  if (named.length === 1) {
    return named[0]
  }
  if (named.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Ambiguous --${flag} ${selector}: ${named.length} project groups are named that. Use the group id.`,
      {
        knownGroups: named.map((group) => ({ id: group.id, name: group.name })),
        nextSteps: named.map((group) => `Use --${flag} id:${group.id} for ${group.name}.`)
      }
    )
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `No project group matches --${flag} ${selector}.`,
    {
      nextSteps: [LIST_HINT]
    }
  )
}
