// Each `orca slack` verb's arguments, from the CLI's flags.
import { randomUUID } from 'node:crypto'
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import type { HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getOptionalStringFlagAllowingEmpty,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { readTextOrFileFlag } from '../arguments/command-body-input'
import { refuseForwardedShell } from './slack-action-files'

/** A message's words from --text or --text-file <path|->; words that are only blanks post nothing. */
export function readMessageText(
  flags: HandlerContext['flags'],
  cwd: string,
  required: true
): Promise<string>
export function readMessageText(
  flags: HandlerContext['flags'],
  cwd: string,
  required: boolean
): Promise<string | undefined>
export async function readMessageText(
  flags: HandlerContext['flags'],
  cwd: string,
  required: boolean
): Promise<string | undefined> {
  const text = await readTextOrFileFlag(flags, cwd, 'text', required)
  if (text !== undefined && !text.trim()) {
    throw new RuntimeClientError('invalid_argument', 'The text is empty.')
  }
  return text
}

// A list's tasks: each --item as given, blanks dropped; none is a mistake.
function listItems(flags: HandlerContext['flags']): string[] {
  const items = getRepeatedStringFlag(flags, 'item')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (items.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'A list needs at least one --item.')
  }
  if (items.length > 50) {
    throw new RuntimeClientError('invalid_argument', 'A list takes at most 50 items at once.')
  }
  return items
}

const AHEAD = /^\+(\d{1,4})([mhd])$/
const UNIT_SECONDS = { m: 60, h: 3_600, d: 86_400 } as const
// A time with its zone, so it means one moment wherever the machine is.
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
/** Slack's own limits on a scheduled message: not in the past, at most 120 days ahead. */
const MAX_AHEAD_SECONDS = 120 * 86_400
const MIN_AHEAD_SECONDS = 60

// The parser rolls a day a month doesn't have into the next one (Nov 31 becomes Dec 1): a date
// that isn't on the calendar is refused instead, by reading it back.
function realDate(zoned: string): boolean {
  const [year, month, day] = zoned.slice(0, 10).split('-').map(Number)
  const read = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0))
  return (
    read.getUTCFullYear() === year && read.getUTCMonth() + 1 === month && read.getUTCDate() === day
  )
}

/** `--at` as the moment to post (epoch seconds): a while from now (+30m, +2h, +3d) or a time with
 *  its zone. Nothing when the flag is absent. */
export function scheduledFor(at: string | undefined, nowMs: number): { postAt?: number } {
  if (at === undefined) {
    return {}
  }
  const now = Math.floor(nowMs / 1000)
  const ahead = AHEAD.exec(at.trim())
  const unit = ahead?.[2]
  const postAt =
    ahead && (unit === 'm' || unit === 'h' || unit === 'd')
      ? now + Number(ahead[1]) * UNIT_SECONDS[unit]
      : ZONED.test(at.trim()) && realDate(at.trim())
        ? Math.floor(Date.parse(at.trim()) / 1000)
        : Number.NaN
  if (!Number.isSafeInteger(postAt)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--at takes a while from now (+30m, +2h, +3d) or a time with its zone (2026-12-01T09:00:00-08:00).'
    )
  }
  if (postAt < now + MIN_AHEAD_SECONDS) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--at must be at least a minute from now. Leave it out to post now.'
    )
  }
  if (postAt > now + MAX_AHEAD_SECONDS) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Slack schedules a post at most 120 days ahead.'
    )
  }
  return { postAt }
}

/** The verbs `orca slack` sends in one call, as connector.act names them; attach takes several. */
export type SlackVerb =
  | 'find'
  | 'check'
  | 'read'
  | 'post'
  | 'react'
  | 'edit'
  | 'delete'
  | 'pin'
  | 'canvas'
  | 'list'
  | 'scheduled'

export async function actionArgs(
  verb: SlackVerb,
  flags: HandlerContext['flags'],
  cwd: string
): Promise<ConnectorActionArgs> {
  switch (verb) {
    case 'react':
      return {
        emoji: getRequiredStringFlag(flags, 'emoji'),
        ...(flags.get('remove') === true ? { remove: true as const } : {})
      }
    case 'read': {
      const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
      const before = getOptionalStringFlag(flags, 'before')
      const download = getOptionalStringFlag(flags, 'download')
      if (download) {
        refuseForwardedShell()
      }
      return {
        ...(limit ? { limit } : {}),
        ...(before ? { before } : {}),
        // The bytes stream to this machine from a link the answer gives, never inline.
        ...(download ? { download, stream: true as const } : {})
      }
    }
    case 'pin':
      return flags.get('remove') === true ? { remove: true as const } : {}
    case 'canvas':
      return {
        title: getRequiredStringFlag(flags, 'title'),
        text: await readMessageText(flags, cwd, true)
      }
    case 'list':
      return { title: getRequiredStringFlag(flags, 'title'), items: listItems(flags) }
    case 'scheduled': {
      // Read with its blank kept: `--cancel ""` is a mistake to refuse, never a request to list.
      const cancel = getOptionalStringFlagAllowingEmpty(flags, 'cancel')
      if (cancel !== undefined && !cancel.trim()) {
        throw new RuntimeClientError(
          'invalid_argument',
          '--cancel takes the id `orca slack scheduled <place>` lists.'
        )
      }
      return cancel ? { cancel: cancel.trim() } : {}
    }
    case 'edit':
      return { text: await readMessageText(flags, cwd, true) }
    case 'post':
      // Minted once here, so the host's retries after a lost answer post it at most once.
      return {
        text: await readMessageText(flags, cwd, true),
        postId: randomUUID(),
        // Read with its blank kept: `--at ""` is a mistake to refuse, never a post sent now.
        ...scheduledFor(getOptionalStringFlagAllowingEmpty(flags, 'at'), Date.now())
      }
    case 'check':
      return flags.get('join') === true ? { join: true } : {}
    case 'find': {
      const workspace = getOptionalStringFlag(flags, 'workspace')
      const text = getOptionalStringFlag(flags, 'search')
      const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
      return {
        ...(workspace ? { workspace } : {}),
        ...(text ? { search: { text }, ...(limit ? { limit } : {}) } : {})
      }
    }
    case 'delete':
      return {}
  }
}
