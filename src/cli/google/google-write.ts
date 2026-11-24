// `orca gmail draft|send|archive|label|mark-read`, `orca calendar create|update|delete|respond|
// suggest-time`: Google changes the host makes as a connected account; this prints them.
import type {
  CalendarSuggestView,
  CalendarWriteView,
  GmailDraftView,
  GmailModifyView,
  GmailSendView
} from '../../shared/google/google-write-types'
import { GMAIL_DRAFT_ATTACH_MAX_BYTES } from '../../shared/google/gmail-draft-request-budget'
import { PAIRED_REQUEST_PARAMS_MAX_BYTES } from '../../shared/remote-runtime/paired-request-budget'
import { splitAddresses } from '../../shared/google/email-address-list'
import { readTextOrFileFlag } from '../arguments/command-body-input'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import {
  formatCalendarSuggest,
  formatCalendarWrite,
  formatGmailDraft,
  formatGmailModify,
  formatGmailSend
} from './google-write-format'
import { RuntimeClientError } from '../runtime/connection/types'
import { callGoogle, googleCallParams } from './google-call'
import { attachedFile } from '../slack/slack-action-files'

type Flags = HandlerContext['flags']

/** A repeatable flag whose values may also be comma-separated: --to a@x.com,b@x.com --to c@x.com.
 *  Commas inside a quoted name ("Lee, Sam" <s@x.com>) stay. */
function list(flags: Flags, name: string): string[] {
  return getRepeatedStringFlag(flags, name).flatMap((value) => splitAddresses(value))
}

function optional(flags: Flags, names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = getOptionalStringFlag(flags, name)
      return value === undefined ? [] : [[name, value]]
    })
  )
}

const on = (flags: Flags, name: string) => flags.get(name) === true

/** The flags every event write shares. */
async function eventFields(flags: Flags, cwd: string) {
  const body = await readTextOrFileFlag(flags, cwd, 'body', false)
  return {
    ...googleCallParams(flags),
    ...optional(flags, ['calendar', 'title', 'start', 'end', 'duration', 'tz', 'where']),
    ...(body === undefined ? {} : { body }),
    with: list(flags, 'with'),
    ...(on(flags, 'meet') ? { meet: true } : {}),
    notify: !on(flags, 'no-notify')
  }
}

async function modify(
  { flags, client, json }: HandlerContext,
  labels: { add: string[]; remove: string[] },
  done: 'archived' | 'marked read' | 'labelled'
) {
  const result = await callGoogle<GmailModifyView>(client, 'google.gmail.modify', {
    ...googleCallParams(flags),
    refs: getRepeatedStringFlag(flags, 'ref'),
    ...labels
  })
  printResult(result, json, (view) => formatGmailModify(view, done))
}

export const GOOGLE_WRITE_HANDLERS: Record<string, CommandHandler> = {
  'gmail draft': async ({ flags, client, json, cwd }) => {
    const body = await readTextOrFileFlag(flags, cwd, 'body', false)
    const draft = getOptionalStringFlag(flags, 'draft')
    if (body === undefined && !draft) {
      throw new RuntimeClientError('invalid_argument', 'Missing --body or --body-file')
    }
    const attachments: { name: string; data: string }[] = []
    // The files travel as base64 in one request, which a paired server caps; they share the cap.
    let room = GMAIL_DRAFT_ATTACH_MAX_BYTES
    for (const path of getRepeatedStringFlag(flags, 'attach')) {
      const file = await attachedFile(cwd, path, {
        maxBytes: room,
        verb: 'a draft (share a Drive link for bigger files)'
      })
      room -= Buffer.byteLength(file.data, 'base64')
      attachments.push(file)
    }
    const params = {
      ...googleCallParams(flags),
      to: list(flags, 'to'),
      cc: list(flags, 'cc'),
      bcc: list(flags, 'bcc'),
      ...optional(flags, ['subject', 'forward', 'draft']),
      ...(getOptionalStringFlag(flags, 'reply-to')
        ? { replyTo: getOptionalStringFlag(flags, 'reply-to') }
        : {}),
      ...(on(flags, 'reply-all') ? { replyAll: true } : {}),
      ...(body === undefined ? {} : { body }),
      attachments
    }
    // A long body beside files near the cap can still overflow the request.
    if (Buffer.byteLength(JSON.stringify(params)) > PAIRED_REQUEST_PARAMS_MAX_BYTES) {
      throw new RuntimeClientError(
        'invalid_argument',
        'The body and attachments together are too large for one draft; shorten the body or share the files as a Drive link.'
      )
    }
    const result = await callGoogle<GmailDraftView>(client, 'google.gmail.draft', params)
    printResult(result, json, formatGmailDraft)
  },
  'gmail send': async ({ flags, client, json }) => {
    const result = await callGoogle<GmailSendView>(client, 'google.gmail.send', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref')
    })
    printResult(result, json, formatGmailSend)
  },
  'gmail archive': (context) => modify(context, { add: [], remove: ['inbox'] }, 'archived'),
  'gmail mark-read': (context) => modify(context, { add: [], remove: ['unread'] }, 'marked read'),
  'gmail label': (context) =>
    modify(
      context,
      { add: list(context.flags, 'add'), remove: list(context.flags, 'remove') },
      'labelled'
    ),
  'calendar create': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<CalendarWriteView>(client, 'google.calendar.create', {
      ...(await eventFields(flags, cwd)),
      ...optional(flags, ['repeat']),
      ...(on(flags, 'all-day') ? { allDay: true } : {})
    })
    printResult(result, json, formatCalendarWrite)
  },
  'calendar update': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<CalendarWriteView>(client, 'google.calendar.update', {
      ...(await eventFields(flags, cwd)),
      ref: getRequiredStringFlag(flags, 'ref'),
      without: list(flags, 'without'),
      ...(on(flags, 'series') ? { series: true } : {})
    })
    printResult(result, json, formatCalendarWrite)
  },
  'calendar delete': async ({ flags, client, json }) => {
    const result = await callGoogle<CalendarWriteView>(client, 'google.calendar.delete', {
      ...googleCallParams(flags),
      ...optional(flags, ['calendar']),
      ref: getRequiredStringFlag(flags, 'ref'),
      ...(on(flags, 'series') ? { series: true } : {}),
      notify: !on(flags, 'no-notify')
    })
    printResult(result, json, formatCalendarWrite)
  },
  'calendar respond': async ({ flags, client, json }) => {
    const result = await callGoogle<CalendarWriteView>(client, 'google.calendar.respond', {
      ...googleCallParams(flags),
      ...optional(flags, ['calendar']),
      ref: getRequiredStringFlag(flags, 'ref'),
      answer: getRequiredStringFlag(flags, 'answer').toLowerCase(),
      ...(on(flags, 'series') ? { series: true } : {})
    })
    printResult(result, json, formatCalendarWrite)
  },
  'calendar suggest-time': async ({ flags, client, json }) => {
    const result = await callGoogle<CalendarSuggestView>(client, 'google.calendar.suggestTime', {
      ...googleCallParams(flags),
      with: list(flags, 'with'),
      duration: getRequiredStringFlag(flags, 'duration'),
      ...optional(flags, ['hours', 'from', 'to'])
    })
    printResult(result, json, formatCalendarSuggest)
  }
}
