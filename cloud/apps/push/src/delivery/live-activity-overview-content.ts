import type { SqlRow } from '@orca-cloud/cloud-database/cloud-database'
import { LiveActivityContributionSchema, type LiveActivityContent } from '@orca-cloud/push-contract/live-activity-messages'

export const LIVE_ACTIVITY_FRESH_MS = 15 * 60_000
const PRIORITY = { attention: 0, failed: 1, working: 2, unavailable: 3, done: 4 }

export function liveActivityOverviewContent(scopes: string[], rows: SqlRow[], createdAt: number, now: number): LiveActivityContent {
  const owners = new Map<string, SqlRow>()
  const bound = new Set<string>()
  const knownOwners = new Set<string>()
  for (const row of rows) {
    if (!scopes.includes(String(row.scope_id))) continue
    bound.add(String(row.scope_id))
    const owner = String(row.owner_fingerprint)
    knownOwners.add(owner)
    if (Number(row.retired) || Number(row.received_at) + LIVE_ACTIVITY_FRESH_MS <= now) continue
    const previous = owners.get(owner)
    if (!previous || Number(previous.received_at) < Number(row.received_at) || (Number(previous.received_at) === Number(row.received_at) && String(row.scope_id) < String(previous.scope_id))) owners.set(owner, row)
  }
  const totalSources = knownOwners.size + scopes.filter((scope) => !bound.has(scope)).length
  const content: LiveActivityContent = {
    schemaVersion: 2, state: 'unavailable', title: 'Orca',
    stateStartedAt: createdAt / 1000, updatedAt: now / 1000,
    counts: { working: 0, attention: 0, done: 0, failed: 0, unavailable: 0 },
    sessions: [], knownSources: 0, totalSources, complete: owners.size === totalSources
  }
  for (const row of owners.values()) {
    const parsed = LiveActivityContributionSchema.shape.content.safeParse(JSON.parse(String(row.content)))
    if (!parsed.success) { content.complete = false; continue }
    const host = parsed.data
    content.complete &&= host.complete && host.counts.unavailable === 0
    if (host.complete && host.counts.unavailable === 0) content.knownSources++
    for (const state of Object.keys(content.counts) as (keyof typeof content.counts)[]) {
      content.counts[state] = Math.min(320000, content.counts[state] + host.counts[state])
    }
    for (const { elapsedSeconds, ...session } of host.sessions) {
      content.sessions.push({ ...session, scopeId: String(row.scope_id), stateStartedAt: Math.max(0, Number(row.received_at) / 1000 - elapsedSeconds) })
    }
  }
  content.sessions.sort((a, b) => PRIORITY[a.state] - PRIORITY[b.state] || a.scopeId.localeCompare(b.scopeId) || a.id.localeCompare(b.id))
  content.sessions = content.sessions.slice(0, 3)
  content.state = content.counts.attention ? 'attention' : content.counts.failed ? 'failed' : content.counts.working ? 'working' : !content.complete ? 'unavailable' : 'done'
  while (Buffer.byteLength(JSON.stringify(content)) > 2200 && content.sessions.length) content.sessions.pop()
  return content
}

export function liveActivityOverviewIdentity(content: LiveActivityContent): string {
  return JSON.stringify([content.state, content.counts, content.knownSources, content.totalSources, content.complete, content.sessions.map(({ id, scopeId, title, state, segment }) => [id, scopeId, title, state, segment])])
}
