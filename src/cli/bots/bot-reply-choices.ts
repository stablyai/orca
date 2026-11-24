// `orca bot reply --choice <label>`: the buttons a reply offers under its text.
import {
  CONNECTOR_REPLY_CHOICE_MAX_CHARS,
  CONNECTOR_REPLY_MAX_CHOICES
} from '../../shared/connector-action-contract'
import type { HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRepeatedStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

/** Undefined without --choice. Checked here, before anything posts, so a bad label posts nothing. */
export function readReplyChoices(flags: HandlerContext['flags']): string[] | undefined {
  const given = getRepeatedStringFlag(flags, 'choice')
  if (given.length === 0) {
    return undefined
  }
  const has = (flag: string) => getOptionalStringFlag(flags, flag) !== undefined
  if (!has('text') && !flags.has('text-file')) {
    throw invalid('--choice needs --text: the question its buttons answer.')
  }
  // Buttons ride on the reply's one message; files and line notes post in other shapes.
  if (has('file') || has('note')) {
    throw invalid('Send --choice in a reply of its own, without --file or --note.')
  }
  if (given.length > CONNECTOR_REPLY_MAX_CHOICES) {
    throw invalid(`A reply offers up to ${CONNECTOR_REPLY_MAX_CHOICES} choices.`)
  }
  const choices = given.map((choice) => choice.trim())
  for (const choice of choices) {
    if (choice.length === 0) {
      throw invalid('Each --choice needs a label.')
    }
    if (choice.length > CONNECTOR_REPLY_CHOICE_MAX_CHARS) {
      throw invalid(
        `--choice "${choice}" is too long: a button shows up to ${CONNECTOR_REPLY_CHOICE_MAX_CHARS} characters.`
      )
    }
  }
  // A press comes back as the label, so two alike couldn't be told apart.
  if (new Set(choices).size !== choices.length) {
    throw invalid('Give each --choice once.')
  }
  return choices
}
