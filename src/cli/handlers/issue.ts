import type {
  RuntimeIssueCreateProvider,
  RuntimeIssueCreateResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatIssueCreate, printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

function getRequiredNonBlankFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = getRequiredStringFlag(flags, name)
  if (value.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return value
}

function getIssueProvider(flags: Map<string, string | boolean>): RuntimeIssueCreateProvider {
  const provider = getRequiredStringFlag(flags, 'provider')
  if (provider === 'github' || provider === 'linear') {
    return provider
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Unsupported issue provider "${provider}". Use github or linear.`
  )
}

export const ISSUE_HANDLERS: Record<string, CommandHandler> = {
  'issue create': async ({ flags, client, json }) => {
    const provider = getIssueProvider(flags)
    const repo = getOptionalStringFlag(flags, 'repo')
    const team = getOptionalStringFlag(flags, 'team')
    if (provider === 'github' && !repo) {
      throw new RuntimeClientError('invalid_argument', 'GitHub issue creation requires --repo')
    }
    if (provider === 'github' && team) {
      throw new RuntimeClientError(
        'invalid_argument',
        'GitHub issue creation uses --repo, not --team'
      )
    }
    if (provider === 'linear' && !team) {
      throw new RuntimeClientError('invalid_argument', 'Linear issue creation requires --team')
    }
    if (provider === 'linear' && repo) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Linear issue creation uses --team, not --repo'
      )
    }
    const result = await client.call<RuntimeIssueCreateResult>('issue.create', {
      provider,
      repo,
      team,
      title: getRequiredNonBlankFlag(flags, 'title'),
      body: getRequiredNonBlankFlag(flags, 'body')
    })
    printResult(result, json, formatIssueCreate)
  }
}
