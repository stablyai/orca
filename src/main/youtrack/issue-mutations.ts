import type {
  YouTrackCreateIssueArgs,
  YouTrackIssueResult,
  YouTrackProjectFieldsResult,
  YouTrackProjectsResult,
  YouTrackUpdateFieldArgs
} from '../../shared/youtrack-types'
import { errorMessage, getCredentials, getIssue, issuePath } from './client'
import { buildFieldPayload, DEFAULT_WORK_TIME, type WorkTime } from './field-payload'
import { isRawRecord } from './raw-record'
import { clearProjectFieldCaches, fetchProjectFields, fetchProjects } from './project-fields'
import { youtrackRequest, type YouTrackCredentials } from './youtrack-request'

let workTime: WorkTime | null = null

/** Drops per-instance caches so a reconnect to another instance never reuses them. */
export function resetYouTrackMetadataCaches(): void {
  workTime = null
  clearProjectFieldCaches()
}

/** Instance work-day settings turn "1d" into minutes; non-admins may be denied, so fall back. */
async function getWorkTime(credentials: YouTrackCredentials): Promise<WorkTime> {
  if (workTime) {
    return workTime
  }
  try {
    const raw = await youtrackRequest(
      credentials,
      '/api/admin/timeTrackingSettings/workTimeSettings?fields=minutesADay,daysAWeek'
    )
    const minutesADay = isRawRecord(raw) ? Number(raw.minutesADay) : Number.NaN
    const daysAWeek = isRawRecord(raw) ? Number(raw.daysAWeek) : Number.NaN
    workTime = minutesADay > 0 && daysAWeek > 0 ? { minutesADay, daysAWeek } : DEFAULT_WORK_TIME
  } catch {
    workTime = DEFAULT_WORK_TIME
  }
  return workTime
}

export async function listProjects(force = false): Promise<YouTrackProjectsResult> {
  try {
    return { ok: true, projects: await fetchProjects(getCredentials(), force) }
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to load YouTrack projects.') }
  }
}

export async function getProjectFields(
  projectId: string,
  force = false
): Promise<YouTrackProjectFieldsResult> {
  try {
    return { ok: true, fields: await fetchProjectFields(getCredentials(), projectId, force) }
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to load project fields.') }
  }
}

export async function updateField(args: YouTrackUpdateFieldArgs): Promise<YouTrackIssueResult> {
  try {
    const credentials = getCredentials()
    const schema = (await fetchProjectFields(credentials, args.projectId)).find(
      (field) => field.name === args.field.name
    )
    if (!schema) {
      return { ok: false, error: `${args.field.name} is not a field of this project.` }
    }
    const built = buildFieldPayload(schema, args.field.values, await getWorkTime(credentials))
    if (!built.ok) {
      return built
    }
    await youtrackRequest(credentials, `${issuePath(args.idReadable)}?fields=id`, {
      method: 'POST',
      body: JSON.stringify({ customFields: [built.payload] })
    })
    return getIssue(args.idReadable)
  } catch (error) {
    return { ok: false, error: errorMessage(error, `Failed to update ${args.field.name}.`) }
  }
}

export async function createIssue(args: YouTrackCreateIssueArgs): Promise<YouTrackIssueResult> {
  try {
    const credentials = getCredentials()
    const schemas = await fetchProjectFields(credentials, args.projectId)
    const time = await getWorkTime(credentials)
    const customFields: Record<string, unknown>[] = []
    for (const input of args.fields) {
      const schema = schemas.find((field) => field.name === input.name)
      if (!schema) {
        return { ok: false, error: `${input.name} is not a field of this project.` }
      }
      // Why skip empty: omitting a field lets YouTrack apply the project default.
      if (input.values.every((value) => !value.trim())) {
        continue
      }
      const built = buildFieldPayload(schema, input.values, time)
      if (!built.ok) {
        return built
      }
      customFields.push(built.payload)
    }
    const raw = await youtrackRequest(credentials, '/api/issues?fields=idReadable', {
      method: 'POST',
      body: JSON.stringify({
        project: { id: args.projectId },
        summary: args.summary,
        ...(args.description ? { description: args.description } : {}),
        customFields
      })
    })
    const idReadable =
      isRawRecord(raw) && typeof raw.idReadable === 'string' ? raw.idReadable : null
    return idReadable
      ? getIssue(idReadable)
      : { ok: false, error: 'YouTrack did not return the created issue.' }
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to create the issue.') }
  }
}
