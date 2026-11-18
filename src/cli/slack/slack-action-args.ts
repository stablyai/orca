// Each `orca slack` verb's arguments, from the CLI's flags.
import { randomUUID } from 'node:crypto'
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import type { HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
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

/** The verbs `orca slack` sends in one call, as connector.act names them; attach takes several. */
export type SlackVerb = 'find' | 'check' | 'read' | 'post' | 'react' | 'edit' | 'delete'

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
    case 'edit':
      return { text: await readMessageText(flags, cwd, true) }
    case 'post':
      // Minted once here, so the host's retries after a lost answer post it at most once.
      return { text: await readMessageText(flags, cwd, true), postId: randomUUID() }
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
