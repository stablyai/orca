import { createHash } from 'node:crypto'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import type { JiraAgileFieldIds } from './jira-issue-mapping'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'
import { acquire, release } from './request-queue'
import { settleJiraSummaryRead, withJiraDeadline } from './jira-read-failure'

const SPRINT_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint'
const STORY_POINTS_TYPE = 'com.pyxis.greenhopper.jira:jsw-story-points'
const NUMBER_FIELD_TYPE = 'com.atlassian.jira.plugin.system.customfieldtypes:float'
const cache = new Map<string, Promise<JiraAgileFieldIds>>()
const discoveryExpiresAt = new Map<string, number>()
const FAILED_DISCOVERY_RETRY_MS = 60_000
const FIELD_CATALOG_TTL_MS = 10 * 60_000

export function pickAgileFieldIds(fields: readonly JiraRecord[]): JiraAgileFieldIds {
  const ids: JiraAgileFieldIds = {}
  for (const field of fields) {
    const custom = asString(asRecord(field.schema).custom)
    const id = asString(field.id)
    if (!id) {
      continue
    }
    if (!ids.sprint && custom === SPRINT_FIELD_TYPE) {
      ids.sprint = id
    }
    if (
      custom === STORY_POINTS_TYPE ||
      (custom === NUMBER_FIELD_TYPE && /story points?/i.test(asString(field.name)))
    ) {
      ids.storyPoints ??= []
      if (!ids.storyPoints.includes(id)) {
        ids.storyPoints.push(id)
      }
    }
  }
  return ids
}

function clientCacheKey(entry: JiraClientForSite): string {
  const credential = createHash('sha256').update(entry.authorization).digest('hex')
  return JSON.stringify([
    entry.site.id,
    entry.site.siteUrl,
    entry.site.authType,
    entry.site.accountId,
    credential
  ])
}

export function getAgileFieldIds(
  entry: JiraClientForSite,
  signal?: AbortSignal
): Promise<JiraAgileFieldIds> {
  if (signal?.aborted) {
    return Promise.reject(new Error('Jira field discovery aborted'))
  }
  const key = clientCacheKey(entry)
  const retryAt = discoveryExpiresAt.get(key)
  if (retryAt !== undefined && retryAt <= Date.now()) {
    cache.delete(key)
    discoveryExpiresAt.delete(key)
  }
  let pending = cache.get(key)
  if (!pending) {
    // Discovery owns a queue slot; no search may hold one while awaiting it.
    pending = withJiraDeadline(undefined, 500, async (requestSignal) => {
      await acquire(requestSignal)
      try {
        const fields = await settleJiraSummaryRead(
          jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/field`, {
            signal: requestSignal
          }),
          requestSignal
        )
        return pickAgileFieldIds(Array.isArray(fields) ? fields : [])
      } finally {
        release()
      }
    })
      .then((fields) => {
        if (cache.get(key) === pending) {
          discoveryExpiresAt.set(key, Date.now() + FIELD_CATALOG_TTL_MS)
        }
        return fields
      })
      .catch((error) => {
        console.warn('[jira] field discovery failed:', error)
        if (cache.get(key) === pending) {
          discoveryExpiresAt.set(key, Date.now() + FAILED_DISCOVERY_RETRY_MS)
        }
        return {}
      })
    if (cache.size >= 32) {
      const oldest = cache.keys().next().value
      if (oldest) {
        cache.delete(oldest)
        discoveryExpiresAt.delete(oldest)
      }
    }
    cache.set(key, pending)
  }
  // A cancelled caller cannot cancel discovery another search is sharing.
  return signal ? settleJiraSummaryRead(pending, signal) : pending
}

export function agileFieldIdList(ids: JiraAgileFieldIds): string[] {
  return [...(ids.sprint ? [ids.sprint] : []), ...(ids.storyPoints ?? [])]
}
