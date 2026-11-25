// google.gmail.*, google.calendar.*, google.contacts.*: reads as a Google account signed in on this
// host, for its owner or a bot whose Google is on. Tokens never leave the host.
import {
  getCalendarEvent,
  listCalendarEvents,
  listCalendars
} from '../../../google/google-calendar-read'
import { findContacts } from '../../../google/google-contacts-read'
import { downloadGmailAttachment, readGmail, searchGmail } from '../../../google/google-gmail-read'
import {
  CalendarCalendarsParams,
  CalendarGetParams,
  CalendarListParams,
  ContactsFindParams,
  GmailAttachmentParams,
  GmailReadParams,
  GmailSearchParams
} from '../../../../shared/rpc-contract/google-read-params'
import { defineMethod } from '../core'
import { googleApiForCaller } from '../google-caller-api'

export const GOOGLE_READ_METHODS = [
  defineMethod({
    name: 'google.gmail.search',
    permission: 'workspace',
    share: 'not-shared',
    params: GmailSearchParams,
    handler: async (params, context) =>
      searchGmail(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.gmail.read',
    permission: 'workspace',
    share: 'not-shared',
    params: GmailReadParams,
    handler: async (params, context) => readGmail(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.gmail.attachment',
    permission: 'workspace',
    share: 'not-shared',
    params: GmailAttachmentParams,
    handler: async (params, context) =>
      downloadGmailAttachment(await googleApiForCaller(params, context), params.ref)
  }),
  defineMethod({
    name: 'google.calendar.list',
    permission: 'workspace',
    share: 'not-shared',
    params: CalendarListParams,
    handler: async (params, context) =>
      listCalendarEvents(await googleApiForCaller(params, context), { ...params, now: Date.now() })
  }),
  defineMethod({
    name: 'google.calendar.calendars',
    permission: 'workspace',
    share: 'not-shared',
    params: CalendarCalendarsParams,
    handler: async (params, context) =>
      listCalendars(await googleApiForCaller(params, context), Date.now())
  }),
  defineMethod({
    name: 'google.calendar.get',
    permission: 'workspace',
    share: 'not-shared',
    params: CalendarGetParams,
    handler: async (params, context) =>
      getCalendarEvent(await googleApiForCaller(params, context), { ...params, now: Date.now() })
  }),
  defineMethod({
    name: 'google.contacts.find',
    permission: 'workspace',
    share: 'not-shared',
    params: ContactsFindParams,
    handler: async (params, context) =>
      findContacts(await googleApiForCaller(params, context), params.query)
  })
] as const
