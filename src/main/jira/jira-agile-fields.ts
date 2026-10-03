import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import type { JiraAgileFieldIds } from './jira-issue-mapping'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'
import { acquire, release } from './request-queue'

const SPRINT_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint'
const STORY_POINT_FIELD_TYPES = new Set([
  'com.pyxis.greenhopper.jira:jsw-story-points',
  'com.atlassian.jira.plugin.system.customfieldtypes:float'
])

// Why: sprint and story points are custom fields whose ids differ per site.
const cache = new Map<string, Promise<JiraAgileFieldIds>>()

export function pickAgileFieldIds(fields: readonly JiraRecord[]): JiraAgileFieldIds {
  const ids: JiraAgileFieldIds = {}
  for (const field of fields) {
    const custom = asString(asRecord(field.schema).custom)
    const id = asString(field.id)
    if (!ids.sprint && custom === SPRINT_FIELD_TYPE) {
      ids.sprint = id
    }
    // "Story Points" (company-managed) and "Story point estimate" (team-managed) both count.
    if (
      !ids.storyPoints &&
      STORY_POINT_FIELD_TYPES.has(custom) &&
      /story point/i.test(asString(field.name))
    ) {
      ids.storyPoints = id
    }
  }
  return ids
}

export function getAgileFieldIds(
  entry: JiraClientForSite,
  signal?: AbortSignal
): Promise<JiraAgileFieldIds> {
  let pending = cache.get(entry.site.id)
  if (!pending) {
    // Why: callers must not hold a queue slot here, or a full pool would deadlock on discovery.
    pending = acquire(signal)
      .then(async () => {
        try {
          const fields = await jiraRequest<JiraRecord[]>(
            entry,
            `${apiBasePath(entry.site)}/field`,
            { signal }
          )
          return pickAgileFieldIds(Array.isArray(fields) ? fields : [])
        } finally {
          release()
        }
      })
      .catch((error) => {
        // Field discovery is best-effort: the list still renders without sprint/points.
        console.warn('[jira] field discovery failed:', error)
        cache.delete(entry.site.id)
        return {}
      })
    cache.set(entry.site.id, pending)
  }
  return pending
}

export function agileFieldIdList(ids: JiraAgileFieldIds): string[] {
  return [ids.sprint, ids.storyPoints].filter((id): id is string => Boolean(id))
}
