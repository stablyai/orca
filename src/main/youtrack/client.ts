import type {
  YouTrackAddCommentResult,
  YouTrackCommentsResult,
  YouTrackConnectArgs,
  YouTrackConnectionStatus,
  YouTrackConnectResult,
  YouTrackIssuePreset,
  YouTrackIssueResult,
  YouTrackListIssuesArgs,
  YouTrackListIssuesResult,
  YouTrackSetStateArgs,
  YouTrackStateOption,
  YouTrackStateOptionsResult
} from '../../shared/youtrack-types'
import {
  clearSite,
  getCredentialError,
  getSite,
  getTokenProtection,
  readToken,
  saveSite
} from './credential-store'
import {
  COMMENT_FIELDS,
  DETAIL_ISSUE_FIELDS,
  LIST_ISSUE_FIELDS,
  toYouTrackComment,
  toYouTrackIssue,
  toYouTrackUser
} from './issue-mapping'
import { activeBundleValues, isRawRecord, type RawRecord } from './raw-record'
import {
  youtrackBaseUrlCandidates,
  youtrackRequest,
  type YouTrackCredentials
} from './youtrack-request'

// Why `Assignee:` over `for:`: `for:` only resolves when the instance maps it to the
// assignee field, and on self-hosted setups it can silently match nothing.
const PRESET_QUERIES: Record<YouTrackIssuePreset, string> = {
  assigned: 'Assignee: me #Unresolved',
  reported: 'reporter: me #Unresolved',
  open: '#Unresolved',
  done: 'Assignee: me #Resolved'
}

const VIEWER_FIELDS = 'id,login,fullName,email,avatarUrl'

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function getCredentials(): YouTrackCredentials {
  const site = getSite()
  const token = site ? readToken() : null
  if (!site || !token) {
    throw new Error('YouTrack is not connected.')
  }
  return { baseUrl: site.baseUrl, token, allowInsecureTls: site.allowInsecureTls === true }
}

export function issuePath(idReadable: string): string {
  return `/api/issues/${encodeURIComponent(idReadable)}`
}

export function getStatus(): YouTrackConnectionStatus {
  const site = getSite()
  const credentialError = getCredentialError()
  return {
    connected: site !== null,
    baseUrl: site?.baseUrl ?? null,
    viewer: site?.viewer ?? null,
    allowInsecureTls: site?.allowInsecureTls === true,
    ...(credentialError ? { credentialError } : {}),
    credentialProtection: site ? getTokenProtection() : null
  }
}

export async function connect(args: YouTrackConnectArgs): Promise<YouTrackConnectResult> {
  let candidates: string[]
  try {
    candidates = youtrackBaseUrlCandidates(args.baseUrl)
  } catch {
    return { ok: false, error: 'Enter a valid YouTrack URL.' }
  }
  const token = args.token.trim()
  if (!token) {
    return { ok: false, error: 'A permanent token is required.' }
  }
  const allowInsecureTls = args.allowInsecureTls === true
  let firstError: string | null = null
  for (const baseUrl of candidates) {
    try {
      const raw = await youtrackRequest(
        { baseUrl, token, allowInsecureTls },
        `/api/users/me?fields=${VIEWER_FIELDS}`
      )
      const viewer = toYouTrackUser(raw, baseUrl)
      if (viewer?.login) {
        saveSite(
          { version: 1, baseUrl, viewer, ...(allowInsecureTls ? { allowInsecureTls } : {}) },
          token
        )
        return { ok: true, viewer }
      }
      firstError ??= 'YouTrack did not return the current user. Check the URL.'
    } catch (error) {
      // Why keep going: the trimmed root may be another service (404, or an auth gateway's
      // 401) while the path as entered is the real instance; report the root's error.
      firstError ??= errorMessage(error, 'Could not connect to YouTrack.')
    }
  }
  return { ok: false, error: firstError ?? 'Could not connect to YouTrack.' }
}

/** Re-verifies the saved token; only runs on an explicit user action. */
export async function testConnection(): Promise<YouTrackConnectResult> {
  try {
    const credentials = getCredentials()
    const viewer = toYouTrackUser(
      await youtrackRequest(credentials, `/api/users/me?fields=${VIEWER_FIELDS}`),
      credentials.baseUrl
    )
    return viewer?.login
      ? { ok: true, viewer }
      : { ok: false, error: 'YouTrack did not return the current user.' }
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Could not reach YouTrack.') }
  }
}

export function disconnect(): void {
  clearSite()
}

export function buildIssueQuery(args: YouTrackListIssuesArgs): string {
  const custom = args.query?.trim()
  const query = custom || PRESET_QUERIES[args.preset ?? 'assigned']
  return /\bsort by\b/i.test(query) ? query : `${query} sort by: updated desc`
}

export async function listIssues(args: YouTrackListIssuesArgs): Promise<YouTrackListIssuesResult> {
  try {
    const credentials = getCredentials()
    const limit = Math.min(Math.max(1, args.limit ?? 50), 200)
    const params = new URLSearchParams({
      query: buildIssueQuery(args),
      fields: LIST_ISSUE_FIELDS,
      $top: String(limit)
    })
    const raw = await youtrackRequest(credentials, `/api/issues?${params}`)
    const issues = (Array.isArray(raw) ? raw : [])
      .map((entry) => toYouTrackIssue(entry, credentials.baseUrl))
      .filter((issue) => issue !== null)
    return { ok: true, issues }
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to load YouTrack issues.') }
  }
}

export async function getIssue(idReadable: string): Promise<YouTrackIssueResult> {
  try {
    const credentials = getCredentials()
    const raw = await youtrackRequest(
      credentials,
      `${issuePath(idReadable)}?fields=${encodeURIComponent(DETAIL_ISSUE_FIELDS)}`
    )
    const issue = toYouTrackIssue(raw, credentials.baseUrl)
    return issue ? { ok: true, issue } : { ok: false, error: `Issue ${idReadable} not found.` }
  } catch (error) {
    return { ok: false, error: errorMessage(error, `Failed to load ${idReadable}.`) }
  }
}

export async function getComments(idReadable: string): Promise<YouTrackCommentsResult> {
  try {
    const credentials = getCredentials()
    const raw = await youtrackRequest(
      credentials,
      `${issuePath(idReadable)}/comments?fields=${encodeURIComponent(COMMENT_FIELDS)}&$top=200`
    )
    const comments = (Array.isArray(raw) ? raw : [])
      .map((entry) => toYouTrackComment(entry, credentials.baseUrl))
      .filter((comment) => comment !== null)
    return { ok: true, comments }
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to load comments.') }
  }
}

export async function addComment(
  idReadable: string,
  text: string
): Promise<YouTrackAddCommentResult> {
  try {
    const credentials = getCredentials()
    const raw = await youtrackRequest(
      credentials,
      `${issuePath(idReadable)}/comments?fields=${encodeURIComponent(COMMENT_FIELDS)}`,
      { method: 'POST', body: JSON.stringify({ text }) }
    )
    const comment = toYouTrackComment(raw, credentials.baseUrl)
    return comment ? { ok: true, comment } : { ok: false, error: 'YouTrack returned no comment.' }
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to add comment.') }
  }
}

const STATE_OPTION_FIELDS =
  'customFields($type,name,value(name),possibleEvents(id,presentation),projectCustomField(bundle(values(id,name,isResolved,archived,ordinal))))'

function readStateField(raw: unknown): RawRecord | null {
  const fields = isRawRecord(raw) && Array.isArray(raw.customFields) ? raw.customFields : []
  return (
    fields
      .filter(isRawRecord)
      .find(
        (entry) =>
          entry.$type === 'StateIssueCustomField' || entry.$type === 'StateMachineIssueCustomField'
      ) ?? null
  )
}

function readEventOptions(field: RawRecord): YouTrackStateOption[] {
  const events = Array.isArray(field.possibleEvents) ? field.possibleEvents : []
  return events
    .filter(isRawRecord)
    .flatMap((event): YouTrackStateOption[] =>
      typeof event.id === 'string' && typeof event.presentation === 'string'
        ? [{ id: event.id, label: event.presentation, kind: 'event' }]
        : []
    )
}

function readValueOptions(field: RawRecord): YouTrackStateOption[] {
  const current = isRawRecord(field.value) ? field.value.name : null
  const projectField = isRawRecord(field.projectCustomField) ? field.projectCustomField : null
  return activeBundleValues(projectField?.bundle).map((value) => {
    const name = String(value.name)
    return {
      id: typeof value.id === 'string' ? value.id : name,
      label: name,
      kind: 'value' as const,
      isResolved: value.isResolved === true,
      current: name === current
    }
  })
}

export async function getStateOptions(idReadable: string): Promise<YouTrackStateOptionsResult> {
  try {
    const credentials = getCredentials()
    const field = readStateField(
      await youtrackRequest(
        credentials,
        `${issuePath(idReadable)}?fields=${encodeURIComponent(STATE_OPTION_FIELDS)}`
      )
    )
    if (!field) {
      return { ok: true, options: [] }
    }
    // Why: workflow-driven state machines only accept their own transitions (events);
    // writing a raw state value there is rejected by YouTrack.
    const options =
      field.$type === 'StateMachineIssueCustomField'
        ? readEventOptions(field)
        : readValueOptions(field)
    return { ok: true, options }
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to load states.') }
  }
}

export async function setState(args: YouTrackSetStateArgs): Promise<YouTrackIssueResult> {
  try {
    const credentials = getCredentials()
    const current = await getIssue(args.idReadable)
    if (!current.ok) {
      return current
    }
    const fieldName = current.issue.stateFieldName
    if (!fieldName) {
      return { ok: false, error: `${args.idReadable} has no state field.` }
    }
    const customField =
      args.option.kind === 'event'
        ? {
            name: fieldName,
            $type: 'StateMachineIssueCustomField',
            event: { id: args.option.id, presentation: args.option.label, $type: 'Event' }
          }
        : { name: fieldName, $type: 'StateIssueCustomField', value: { name: args.option.label } }
    await youtrackRequest(credentials, `${issuePath(args.idReadable)}?fields=id`, {
      method: 'POST',
      body: JSON.stringify({ customFields: [customField] })
    })
    return getIssue(args.idReadable)
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to change state.') }
  }
}
