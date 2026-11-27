// `orca gmail search|read`, `orca calendar list|get`, `orca contacts find`: Google reads the host runs
// as a connected account; this prints them.
import type {
  CalendarEventView,
  CalendarListView,
  CalendarsView,
  ContactsFindView,
  GmailAttachment,
  GmailReadView,
  GmailSearchView
} from '../../shared/google/google-read-types'
import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { callGoogle, googleCallParams } from './google-call'
import {
  formatCalendarEvent,
  formatCalendarList,
  formatCalendars,
  formatContacts,
  formatGmailRead,
  formatGmailSearch
} from './google-read-format'
import { refuseForwardedShell, saveDownload } from '../slack/slack-action-files'

export const GOOGLE_READ_HANDLERS: Record<string, CommandHandler> = {
  'gmail search': async ({ flags, client, json }) => {
    const query = getRequiredStringFlag(flags, 'query')
    const page = getOptionalStringFlag(flags, 'page')
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const result = await callGoogle<GmailSearchView>(client, 'google.gmail.search', {
      ...googleCallParams(flags),
      query,
      ...(page ? { pageToken: page } : {}),
      ...(limit !== undefined ? { limit } : {})
    })
    printResult(result, json, (view) => formatGmailSearch(view, query))
  },
  'gmail read': async ({ flags, client, json, cwd }) => {
    const download = getOptionalStringFlag(flags, 'download')
    if (download) {
      refuseForwardedShell()
      const result = await callGoogle<GmailAttachment & { data: string }>(
        client,
        'google.gmail.attachment',
        { ...googleCallParams(flags), ref: download }
      )
      const { data: _data, ...file } = result.result
      const savedTo = await saveDownload(cwd, getOptionalStringFlag(flags, 'out'), {
        id: file.ref.replaceAll(':', '-'),
        name: file.name,
        data: result.result.data
      })
      printResult(
        { ...result, result: { ...file, savedTo } },
        json,
        () => `Saved ${file.name} to ${savedTo}`
      )
      return
    }
    const ref = getRequiredStringFlag(flags, 'ref')
    const offset = getOptionalNonNegativeIntegerFlag(flags, 'offset')
    const result = await callGoogle<GmailReadView>(client, 'google.gmail.read', {
      ...googleCallParams(flags),
      ref,
      ...(offset !== undefined ? { offset } : {})
    })
    printResult(result, json, (view) => formatGmailRead(view, ref))
  },
  'calendar list': async ({ flags, client, json }) => {
    if (flags.get('calendars') === true) {
      const result = await callGoogle<CalendarsView>(
        client,
        'google.calendar.calendars',
        googleCallParams(flags)
      )
      printResult(result, json, formatCalendars)
      return
    }
    const optional = (name: string) => {
      const value = getOptionalStringFlag(flags, name)
      return value ? { [name]: value } : {}
    }
    const page = getOptionalStringFlag(flags, 'page')
    const result = await callGoogle<CalendarListView>(client, 'google.calendar.list', {
      ...googleCallParams(flags),
      ...optional('calendar'),
      ...optional('from'),
      ...optional('to'),
      ...(page ? { pageToken: page } : {})
    })
    printResult(result, json, formatCalendarList)
  },
  'calendar get': async ({ flags, client, json }) => {
    const calendar = getOptionalStringFlag(flags, 'calendar')
    const result = await callGoogle<CalendarEventView>(client, 'google.calendar.get', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref'),
      ...(calendar ? { calendar } : {})
    })
    printResult(result, json, formatCalendarEvent)
  },
  'contacts find': async ({ flags, client, json }) => {
    const result = await callGoogle<ContactsFindView>(client, 'google.contacts.find', {
      ...googleCallParams(flags),
      query: getRequiredStringFlag(flags, 'query')
    })
    printResult(result, json, formatContacts)
  }
}
