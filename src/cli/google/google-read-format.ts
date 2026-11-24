// How `orca gmail|calendar|contacts` print their answers: Orca's own lines plain, everything a
// sender, organizer or author wrote fenced as content, the content capped, and paging lines after it.
import type {
  CalendarEventSummary,
  CalendarEventView,
  CalendarListView,
  CalendarsView,
  ContactsFindView,
  GmailReadView,
  GmailSearchView
} from '../../shared/google/google-read-types'
import { inlineUntrusted, untrustedContent } from '../../shared/quoted-text-fence'
import { TOOL_OUTPUT_MAX_CHARS, truncationNote } from '../../shared/tool-output-limits'

const SOURCE_NAMES: Record<ContactsFindView['people'][number]['source'], string> = {
  contacts: 'contacts',
  other: 'emailed before',
  directory: 'company directory'
}

function parts(epochMs: number, timeZone: string | undefined, withYear: boolean) {
  const shown = new Intl.DateTimeFormat('en-GB', {
    ...(timeZone ? { timeZone } : {}),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(epochMs))
  const get = (type: string) => shown.find((part) => part.type === type)?.value ?? ''
  const day = [get('weekday'), get('day'), get('month'), ...(withYear ? [get('year')] : [])]
  return { day: day.join(' '), time: `${get('hour')}:${get('minute')}` }
}

/** "Tue 3 Nov 14:05" in the zone, or this computer's when none is given. */
export function formatWhen(epochMs: number, timeZone?: string): string {
  const { day, time } = parts(epochMs, timeZone, false)
  return `${day} ${time}`
}

/** Every calendar answer starts here, so a bot never guesses today or the zone. */
export function formatNow(now: number, timeZone: string): string {
  const { day, time } = parts(now, timeZone, true)
  return `Now: ${day} ${time} ${timeZone}`
}

function eventTime(event: CalendarEventSummary, timeZone: string): string {
  if (event.allDay) {
    const day = (date: string) => parts(Date.parse(`${date}T12:00:00Z`), 'UTC', false).day
    // An all-day event's end date is the day after it ends.
    const last = new Date(Date.parse(`${event.end}T12:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10)
    return last > event.start
      ? `${day(event.start)} – ${day(last)}, all day`
      : `${day(event.start)}, all day`
  }
  const start = parts(Date.parse(event.start), timeZone, false)
  const end = parts(Date.parse(event.end), timeZone, false)
  return start.day === end.day
    ? `${start.day} ${start.time}–${end.time}`
    : `${start.day} ${start.time} – ${end.day} ${end.time}`
}

function replies(event: CalendarEventSummary): string | null {
  if (event.attendees.length === 0) {
    return null
  }
  const count = (response: string) =>
    event.attendees.filter((attendee) => attendee.response === response).length
  const shown = [
    [count('accepted'), 'yes'],
    [count('declined'), 'no'],
    [count('tentative'), 'maybe'],
    [count('needsAction'), 'waiting']
  ].flatMap(([n, word]) => (n ? [`${n} ${word}`] : []))
  return `${event.attendees.length} invited: ${shown.join(', ')}`
}

export function eventLine(event: CalendarEventSummary, timeZone: string): string {
  return [
    event.ref,
    eventTime(event, timeZone),
    inlineUntrusted(event.title),
    ...(event.recurring ? ['repeats'] : []),
    ...(replies(event) ? [replies(event)] : []),
    ...(event.location ? [`at ${inlineUntrusted(event.location)}`] : []),
    ...(event.meetUrl ? [`Meet ${event.meetUrl}`] : [])
  ].join(' · ')
}

/** Fenced content, cut at the cap with Orca's note outside the fence. */
function cappedUntrusted(label: string, text: string, hint: string): string {
  return text.length <= TOOL_OUTPUT_MAX_CHARS
    ? untrustedContent(label, text)
    : `${untrustedContent(label, text.slice(0, TOOL_OUTPUT_MAX_CHARS))}\n${truncationNote(text.length, hint)}`
}

const accountFlag = (account: string) => ` --account ${account}`

export function formatGmailSearch(view: GmailSearchView, query: string): string {
  if (view.threads.length === 0) {
    return `No mail for ${view.account} matches ${JSON.stringify(query)}.`
  }
  const about = view.estimate !== undefined ? ` (about ${view.estimate})` : ''
  const lines = view.threads.map((thread) =>
    [
      `${thread.ref} · ${formatWhen(thread.at)} · ${inlineUntrusted(thread.from)} · ${thread.messages} message${thread.messages === 1 ? '' : 's'}${thread.unread ? ', unread' : ''}`,
      `  ${inlineUntrusted(thread.subject) || '(no subject)'}`,
      ...(thread.snippet ? [`  ${inlineUntrusted(thread.snippet, 300)}`] : [])
    ].join('\n')
  )
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return [
    `${view.threads.length} threads for ${view.account}${about}, times in ${zone}; \`orca gmail read <ref>\` opens one.`,
    cappedUntrusted(
      'senders, subjects and snippets as the mail has them',
      lines.join('\n'),
      'Narrow the search or pass a smaller --limit.'
    ),
    ...(view.nextPageToken
      ? [
          `Next page: orca gmail search ${JSON.stringify(query)} --page ${view.nextPageToken}${accountFlag(view.account)}`
        ]
      : [])
  ].join('\n')
}

export function formatGmailRead(view: GmailReadView, ref: string): string {
  // The reader budgets headers and attachment lines into its page, so this needs no cap.
  const messages = view.messages.map((message) => {
    const headers = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      ...(message.cc ? [`Cc: ${message.cc}`] : []),
      `Date: ${formatWhen(message.at)}`
    ]
    const part = message.part
      ? [
          `[Orca: characters ${message.part.from}–${message.part.to} of ${message.part.of} in this message]`
        ]
      : []
    return [
      untrustedContent(message.ref, [...headers, '', message.body || '(no text)'].join('\n')),
      ...part,
      ...message.attachments.map(
        (file) =>
          `[Orca: attachment ${file.ref}: ${inlineUntrusted(file.name, 120)}${file.type ? `, ${file.type}` : ''}${file.size === undefined ? '' : `, ${Math.ceil(file.size / 1024)} KB`}; --download ${file.ref} saves it]`
      )
    ].join('\n')
  })
  return [
    `${view.ref} in ${view.account}, times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    untrustedContent('subject', view.subject.slice(0, 1_000) || '(no subject)'),
    ...messages,
    ...(view.nextOffset !== undefined
      ? [`More: orca gmail read ${ref} --offset ${view.nextOffset}${accountFlag(view.account)}`]
      : [])
  ].join('\n')
}

export function formatCalendarList(view: CalendarListView): string {
  const window = `${formatWhen(Date.parse(view.from), view.timeZone)} – ${formatWhen(Date.parse(view.to), view.timeZone)}`
  const head = [
    formatNow(view.now, view.timeZone),
    `Calendar ${view.calendar.id} for ${view.account}, ${window}`,
    untrustedContent('calendar name', inlineUntrusted(view.calendar.name))
  ]
  if (view.events.length === 0) {
    return [...head, 'No events in that window.'].join('\n')
  }
  return [
    ...head,
    cappedUntrusted(
      'titles and places as their organizers wrote them',
      view.events.map((event) => eventLine(event, view.timeZone)).join('\n'),
      'Pick a shorter window with --from/--to.'
    ),
    '`orca calendar get <ref>` shows one in full.',
    ...(view.nextPageToken
      ? [
          `Next page: orca calendar list --calendar ${view.calendar.id} --from ${view.from} --to ${view.to} --page ${view.nextPageToken}${accountFlag(view.account)}`
        ]
      : [])
  ].join('\n')
}

export function formatCalendarEvent(view: CalendarEventView): string {
  const { event } = view
  const people = event.attendees.map(
    (attendee) =>
      `  ${attendee.name ? `${inlineUntrusted(attendee.name, 80)} <${inlineUntrusted(attendee.email, 120)}>` : inlineUntrusted(attendee.email, 120)}: ${attendee.response === 'needsAction' ? 'waiting' : attendee.response}${attendee.organizer ? ' (organizer)' : ''}${attendee.self ? ' (you)' : ''}`
  )
  return [
    formatNow(view.now, view.timeZone),
    `${event.ref} on calendar ${view.calendar.id} for ${view.account}`,
    cappedUntrusted(
      'the event, its calendar and people as their owners wrote them',
      [
        event.title,
        eventTime(event, view.timeZone) + (event.recurring ? ' (repeats)' : ''),
        `Calendar: ${view.calendar.name}`,
        ...(event.location ? [`Where: ${event.location}`] : []),
        ...(event.organizer ? [`Organizer: ${event.organizer}`] : []),
        ...(people.length > 0 ? ['People:', ...people] : []),
        ...(event.description ? ['', event.description] : [])
      ].join('\n'),
      'The description is long; open the event link for the rest.'
    ),
    ...(event.meetUrl ? [`Meet: ${event.meetUrl}`] : []),
    ...(event.htmlLink ? [`Open: ${event.htmlLink}`] : [])
  ].join('\n')
}

export function formatCalendars(view: CalendarsView): string {
  return [
    formatNow(view.now, view.timeZone),
    cappedUntrusted(
      'calendar names as their owners wrote them',
      view.calendars
        .map(
          (calendar) =>
            `${calendar.id}  ${inlineUntrusted(calendar.name)}${calendar.primary ? ' (primary)' : ''} · ${calendar.access}`
        )
        .join('\n'),
      'Pick one by id with --calendar.'
    ),
    'Pass one to --calendar by id or name.'
  ].join('\n')
}

export function formatContacts(view: ContactsFindView): string {
  const skipped = view.skipped.map(
    (entry) =>
      `[Orca: ${SOURCE_NAMES[entry.source]} not searched: ${inlineUntrusted(entry.reason)}]`
  )
  if (view.people.length === 0) {
    return [`Nobody named ${JSON.stringify(view.query)} for ${view.account}.`, ...skipped].join(
      '\n'
    )
  }
  return [
    `${view.people.length} found for ${view.account}`,
    cappedUntrusted(
      'names and titles as the people or their senders wrote them',
      view.people
        .map(
          (person) =>
            `${inlineUntrusted(person.name, 80)} <${person.emails.map((email) => inlineUntrusted(email, 120)).join('>, <')}>${person.title ? ` · ${inlineUntrusted(person.title, 80)}` : ''} · ${SOURCE_NAMES[person.source]}`
        )
        .join('\n'),
      'Search a fuller name.'
    ),
    ...skipped
  ].join('\n')
}
