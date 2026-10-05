import {
  YOUTRACK_BODY_MAX_CHARS,
  YOUTRACK_ISSUE_PRESETS,
  type YouTrackComment,
  type YouTrackIssue
} from '../../shared/youtrack-types'
import type { CurrentWorktreeContextHints } from '../../shared/current-worktree-context'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { readBodyFlags, type BodyFlagLimit } from '../body-flag-input'
import { buildCurrentWorktreeContext } from '../current-worktree-context'
import { RuntimeClientError } from '../runtime-client'
import {
  formatYouTrackComment,
  formatYouTrackIssue,
  formatYouTrackIssueList,
  formatYouTrackIssueSaved
} from '../youtrack-format'

const WRITE_TIMEOUT_MS = 60_000

type IssueTarget = { id?: string; current?: CurrentWorktreeContextHints }

function buildIssueTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  remote: boolean
): IssueTarget {
  const id = getOptionalStringFlag(flags, 'id')
  if (flags.get('current') === true) {
    if (id) {
      throw new RuntimeClientError('invalid_argument', 'Use either an issue ID or --current')
    }
    return { current: buildCurrentWorktreeContext(cwd, remote) }
  }
  if (!id) {
    throw new RuntimeClientError('invalid_argument', 'Pass an issue ID or --current')
  }
  return { id }
}

const YOUTRACK_BODY_LIMIT: BodyFlagLimit = {
  maxChars: YOUTRACK_BODY_MAX_CHARS,
  tooLarge: () =>
    new RuntimeClientError(
      'invalid_argument',
      `YouTrack text must be at most ${YOUTRACK_BODY_MAX_CHARS} characters`
    )
}

/** "Name=Value" pairs; repeating a name builds a multi-value field. */
function parseFieldFlags(entries: string[]): { name: string; values: string[] }[] {
  const byName = new Map<string, string[]>()
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--field must look like Name=Value: ${entry}`
      )
    }
    const name = entry.slice(0, separator).trim()
    byName.set(name, [...(byName.get(name) ?? []), entry.slice(separator + 1)])
  }
  return [...byName].map(([name, values]) => ({ name, values }))
}

export const YOUTRACK_HANDLERS: Record<string, CommandHandler> = {
  'youtrack issue': async ({ flags, client, cwd, json }) => {
    const response = await client.call<{ issue: YouTrackIssue; comments?: YouTrackComment[] }>(
      'youtrack.issue',
      { ...buildIssueTarget(flags, cwd, client.isRemote), comments: flags.get('comments') === true }
    )
    printResult(response, json, formatYouTrackIssue)
  },
  'youtrack list': async ({ flags, client, json }) => {
    const preset = getOptionalStringFlag(flags, 'preset')
    if (preset && !YOUTRACK_ISSUE_PRESETS.some((value) => value === preset)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--preset must be one of ${YOUTRACK_ISSUE_PRESETS.join(', ')}`
      )
    }
    const response = await client.call<{ issues: YouTrackIssue[] }>('youtrack.list', {
      preset,
      query: getOptionalStringFlag(flags, 'query'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(response, json, formatYouTrackIssueList)
  },
  'youtrack comment add': async ({ flags, client, cwd, json }) => {
    const text =
      (await readBodyFlags(flags, cwd, { required: true, limit: YOUTRACK_BODY_LIMIT })) ?? ''
    const response = await client.call<{ idReadable: string; comment: YouTrackComment }>(
      'youtrack.commentAdd',
      { ...buildIssueTarget(flags, cwd, client.isRemote), text },
      { timeoutMs: WRITE_TIMEOUT_MS }
    )
    printResult(response, json, formatYouTrackComment)
  },
  'youtrack state set': async ({ flags, client, cwd, json }) => {
    const response = await client.call<{ issue: YouTrackIssue }>(
      'youtrack.stateSet',
      {
        ...buildIssueTarget(flags, cwd, client.isRemote),
        state: getRequiredStringFlag(flags, 'to')
      },
      { timeoutMs: WRITE_TIMEOUT_MS }
    )
    printResult(response, json, formatYouTrackIssueSaved)
  },
  'youtrack field set': async ({ flags, client, cwd, json }) => {
    const values = getRepeatedStringFlag(flags, 'value')
    const clear = flags.get('clear') === true
    if (clear === values.length > 0) {
      throw new RuntimeClientError('invalid_argument', 'Pass --value (repeatable) or --clear')
    }
    const response = await client.call<{ issue: YouTrackIssue }>(
      'youtrack.fieldSet',
      {
        ...buildIssueTarget(flags, cwd, client.isRemote),
        name: getRequiredStringFlag(flags, 'name'),
        values
      },
      { timeoutMs: WRITE_TIMEOUT_MS }
    )
    printResult(response, json, formatYouTrackIssueSaved)
  },
  'youtrack create': async ({ flags, client, cwd, json }) => {
    const response = await client.call<{ issue: YouTrackIssue }>(
      'youtrack.create',
      {
        project: getRequiredStringFlag(flags, 'project'),
        summary: getRequiredStringFlag(flags, 'summary'),
        description: await readBodyFlags(flags, cwd, {
          required: false,
          limit: YOUTRACK_BODY_LIMIT
        }),
        fields: parseFieldFlags(getRepeatedStringFlag(flags, 'field'))
      },
      { timeoutMs: WRITE_TIMEOUT_MS }
    )
    printResult(response, json, formatYouTrackIssueSaved)
  }
}
