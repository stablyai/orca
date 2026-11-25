// google.gmail.draft|send|modify and google.calendar.create|update|delete|respond|suggestTime: changes
// made as a Google account signed in on this host, for its owner or a bot whose Google is on. Text a
// bot writes for someone other than its owner ends with who asked, as on Linear.
import {
  createCalendarEvent,
  deleteCalendarEvent,
  respondToCalendarEvent,
  updateCalendarEvent
} from '../../../google/google-calendar-write'
import { suggestCalendarTime } from '../../../google/google-calendar-free-time'
import { modifyGmail, saveGmailDraft, sendGmailDraft } from '../../../google/google-gmail-write'
import {
  CalendarCreateParams,
  CalendarDeleteParams,
  CalendarRespondParams,
  CalendarSuggestTimeParams,
  CalendarUpdateParams,
  GmailDraftParams,
  GmailModifyParams,
  GmailSendParams
} from '../../../../shared/rpc-contract/google-write-params'
import { defineMethod } from '../core'
import { attributedGoogleText, googleApiForCaller } from '../google-caller-api'

export const GOOGLE_WRITE_METHODS = [
  defineMethod({
    name: 'google.gmail.draft',
    permission: 'workspace',
    share: 'not-shared',
    params: GmailDraftParams,
    handler: async (params, context) => {
      const api = await googleApiForCaller(params, context)
      const body = await attributedGoogleText(params.body, params, context)
      return saveGmailDraft(api, { ...params, ...(body === undefined ? {} : { body }) })
    }
  }),
  defineMethod({
    name: 'google.gmail.send',
    permission: 'workspace',
    share: 'not-shared',
    params: GmailSendParams,
    handler: async (params, context) =>
      sendGmailDraft(await googleApiForCaller(params, context), params.ref)
  }),
  defineMethod({
    name: 'google.gmail.modify',
    permission: 'workspace',
    share: 'not-shared',
    params: GmailModifyParams,
    handler: async (params, context) =>
      modifyGmail(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.calendar.create',
    permission: 'workspace',
    share: 'not-shared',
    params: CalendarCreateParams,
    handler: async (params, context) => {
      const api = await googleApiForCaller(params, context)
      const body = await attributedGoogleText(params.body, params, context)
      return createCalendarEvent(api, {
        ...params,
        ...(body === undefined ? {} : { body }),
        now: Date.now()
      })
    }
  }),
  defineMethod({
    name: 'google.calendar.update',
    permission: 'workspace',
    share: 'not-shared',
    params: CalendarUpdateParams,
    handler: async (params, context) =>
      updateCalendarEvent(await googleApiForCaller(params, context), { ...params, now: Date.now() })
  }),
  defineMethod({
    name: 'google.calendar.delete',
    permission: 'workspace',
    share: 'not-shared',
    params: CalendarDeleteParams,
    handler: async (params, context) =>
      deleteCalendarEvent(await googleApiForCaller(params, context), { ...params, now: Date.now() })
  }),
  defineMethod({
    name: 'google.calendar.respond',
    permission: 'workspace',
    share: 'not-shared',
    params: CalendarRespondParams,
    handler: async (params, context) =>
      respondToCalendarEvent(await googleApiForCaller(params, context), {
        ...params,
        now: Date.now()
      })
  }),
  defineMethod({
    name: 'google.calendar.suggestTime',
    permission: 'workspace',
    share: 'not-shared',
    params: CalendarSuggestTimeParams,
    handler: async (params, context) =>
      suggestCalendarTime(await googleApiForCaller(params, context), { ...params, now: Date.now() })
  })
] as const
