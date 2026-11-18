// How `orca gmail draft|send|archive|label|mark-read` and the calendar writes print: Orca's line
// saying what changed, then what Google holds (subjects, people, titles, someone else's in a reply or
// an invite) fenced as content, then the next step.
import type {
  CalendarSuggestView,
  CalendarWriteView,
  GmailDraftView,
  GmailModifyView,
  GmailSendView
} from '../../shared/google/google-write-types'
import { inlineUntrusted, untrustedContent } from '../../shared/quoted-text-fence'
import { eventLine, formatNow, formatWhen } from './google-read-format'

/** The mail's subject and people, as Google holds them, fenced. */
function mailContent(view: {
  subject: string
  to: string[]
  cc: string[]
  bcc: string[]
  attachments?: string[]
}): string {
  const list = (label: string, entries: string[] | undefined) =>
    entries && entries.length > 0 ? [`${label}: ${entries.join(', ')}`] : []
  return untrustedContent(
    'the subject and people as the mail has them',
    [
      `Subject: ${view.subject || '(no subject)'}`,
      ...list('To', view.to),
      ...list('Cc', view.cc),
      ...list('Bcc', view.bcc),
      ...list('Attached', view.attachments)
    ].join('\n')
  )
}

export function formatGmailDraft(view: GmailDraftView): string {
  const what =
    view.kind === 'reply' ? 'Reply draft' : view.kind === 'forward' ? 'Forward draft' : 'Draft'
  return [
    `${what} ${view.ref} ${view.updated ? 'updated' : 'saved'} for ${view.account} in ${view.threadRef}, not sent.`,
    mailContent(view),
    `Open: ${view.link}`,
    `Send: orca gmail send ${view.ref}   Revise: orca gmail draft --draft ${view.ref} …`
  ].join('\n')
}

export function formatGmailSend(view: GmailSendView): string {
  return [
    `Sent from ${view.account}: ${view.messageRef} in ${view.threadRef}.`,
    mailContent(view)
  ].join('\n')
}

export function formatGmailModify(
  view: GmailModifyView,
  done: 'archived' | 'marked read' | 'labelled'
): string {
  const count = `${view.refs.length} ${view.refs.length === 1 ? 'item' : 'items'}`
  if (done !== 'labelled') {
    return `${done === 'archived' ? 'Archived' : 'Marked read'} ${count} for ${view.account}.`
  }
  const changes = [
    ...(view.added.length > 0 ? [`added ${view.added.join(', ')}`] : []),
    ...(view.removed.length > 0 ? [`took off ${view.removed.join(', ')}`] : [])
  ]
  const created = view.created.length > 0 ? ` (new label: ${view.created.join(', ')})` : ''
  return `Labels on ${count} for ${view.account}: ${changes.join('; ')}${created}.`
}

const ANSWERED = { accepted: 'Accepted', declined: 'Declined', tentative: 'Answered maybe to' }

export function formatCalendarWrite(view: CalendarWriteView): string {
  const scope = view.series ? ' (every occurrence)' : ''
  const head =
    view.action === 'responded' && view.response
      ? `${ANSWERED[view.response]}${scope}:`
      : view.action === 'deleted'
        ? view.cancelled
          ? `Cancelled${scope}:`
          : `Took off ${view.calendar.id}${scope}:`
        : `${view.action === 'created' ? 'Created' : 'Updated'}${scope} on ${view.calendar.id} for ${view.account}:`
  return [
    formatNow(view.now, view.timeZone),
    head,
    untrustedContent(
      'the event as its organizer wrote it',
      [
        eventLine(view.event, view.timeZone),
        ...(view.notified.length > 0 ? [`Invites emailed to: ${view.notified.join(', ')}`] : [])
      ].join('\n')
    )
  ].join('\n')
}

export function formatCalendarSuggest(view: CalendarSuggestView): string {
  const who = view.people.length > 0 ? `you and ${view.people.join(', ')}` : 'you'
  const unknown = view.unknown.map(
    (entry) => `Unknown: ${entry.email} (${inlineUntrusted(entry.reason)}); they may be busy.`
  )
  const head = [
    formatNow(view.now, view.timeZone),
    `Free ${view.durationMinutes} min for ${who}, weekdays ${view.hours.from}–${view.hours.to} ${view.timeZone}, ${formatWhen(Date.parse(view.from), view.timeZone)} – ${formatWhen(Date.parse(view.to), view.timeZone)}:`
  ]
  if (view.slots.length === 0) {
    return [
      ...head,
      'No free slot in that window. Try other --hours, a longer --to, or a shorter --duration.',
      ...unknown
    ].join('\n')
  }
  return [
    ...head,
    ...view.slots.map((slot, index) => {
      const end = formatWhen(Date.parse(slot.end), view.timeZone).split(' ').at(-1)
      return `${index + 1}. ${formatWhen(Date.parse(slot.start), view.timeZone)}–${end}`
    }),
    ...unknown,
    'Book one: orca calendar create --title … --start <time> --duration … --with …'
  ].join('\n')
}
