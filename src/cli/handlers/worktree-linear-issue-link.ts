import { parseLinearIssueInput } from '../../shared/linear-links'
import { RuntimeClientError } from '../runtime-client'

type LinearIssueLinkParams = {
  linkedLinearIssue: string | null
  linkedLinearIssueWorkspaceId: string | null
  linkedLinearIssueOrganizationUrlKey: string | null
}

export function getOptionalLinearIssueLinkFlag(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowNull?: boolean } = {}
): LinearIssueLinkParams | undefined {
  const value = getPresentStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }

  if (value.trim().toLowerCase() === 'null') {
    if (!options.allowNull) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Omit --linear-issue on create, or pass a Linear issue identifier or URL.'
      )
    }
    return {
      linkedLinearIssue: null,
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null
    }
  }

  const parsed = parseLinearIssueInput(value)
  if (!parsed) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass a Linear issue identifier like STA-335, a Linear issue URL, or null to clear.'
    )
  }

  return {
    linkedLinearIssue: parsed.identifier,
    // Why: changing a link must not keep a workspace id from a previous issue.
    // The org key from URLs is enough for current-resolution to safely rehydrate it.
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: parsed.organizationUrlKey ?? null
  }
}

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}
