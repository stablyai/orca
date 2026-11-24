import type { TrackedActivity } from './host-live-activity-record'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import type { PushGatewayClient } from '../push-gateway-client'
import { findPrincipalDevice } from '../../rpc/server/pairing/device-entry'
import { agentOverviewContent } from './agent-overview-content'

const HEARTBEAT_MS = 5 * 60_000

type DeliveryContext = {
  runtime: Pick<OrcaRuntimeService, 'projectLocalAgentSessionTabs'>
  registry: DeviceRegistry
  gateway: Pick<PushGatewayClient, 'sendLiveActivity' | 'registerLiveActivityOverview'>
  isCurrent: () => boolean
  refreshCensus: () => Promise<void>
  remove: () => void
}

export async function deliverHostLiveActivity(
  entry: TrackedActivity,
  context: DeliveryContext
): Promise<void> {
  if (!context.isCurrent()) {
    return
  }
  let now = Date.now()
  if (now >= entry.expiresAt) {
    context.remove()
    return
  }
  if (entry.input.bootstrap && !entry.bootstrapReady) {
    const requested = JSON.stringify(entry.input.bootstrap)
    const accepted = await context.gateway
      .registerLiveActivityOverview({
        schemaVersion: 2,
        overviewId: entry.input.overviewId,
        ...entry.input.bootstrap
      })
      .catch(() => false)
    if (!accepted) {
      entry.nextAt = now + 30_000
      return
    }
    if (JSON.stringify(entry.input.bootstrap) !== requested) {
      entry.nextAt = Date.now()
      return
    }
    entry.bootstrapReady = true
    if (!context.isCurrent()) {
      return
    }
  }
  if (
    (!entry.authoritative && now - entry.censusAt >= 30_000) ||
    now - entry.censusAt >= HEARTBEAT_MS
  ) {
    await context.refreshCensus()
  }
  if (!context.isCurrent()) {
    return
  }
  now = Date.now()
  const projected = [...entry.frames.values()].map((frame) =>
    context.runtime.projectLocalAgentSessionTabs(frame)
  )
  entry.authoritative = entry.censusAuthoritative && projected.every((result) => result.complete)
  const content = agentOverviewContent(
    entry.censusAuthoritative ? projected.map((result) => result.frame) : [],
    entry.input.activityId,
    entry.input.showNames,
    now
  )
  content.complete &&= entry.authoritative
  entry.content = content
  const identity = JSON.stringify([
    content.counts,
    content.complete,
    content.sessions.map(({ id, title, state, segment, agent }) => [
      id,
      title,
      state,
      segment,
      agent
    ])
  ])
  if (entry.sent === identity && now - entry.sentAt < HEARTBEAT_MS) {
    entry.nextAt = Math.min(
      entry.sentAt + HEARTBEAT_MS,
      entry.expiresAt,
      entry.authoritative ? Infinity : entry.censusAt + 30_000
    )
    return
  }
  const timestamp = Math.floor(now / 1000)
  if (timestamp <= entry.timestamp) {
    entry.nextAt = (entry.timestamp + 1) * 1000
    return
  }
  if (
    findPrincipalDevice(context.registry.listDevices({ fresh: true }), entry.principal)?.scope !==
    'mobile'
  ) {
    context.remove()
    return
  }
  const event = now >= entry.expiresAt ? 'end' : 'update'
  entry.timestamp = timestamp
  const sequence = ++entry.sequence
  const device = context.registry.getDevice(entry.principal.deviceId)
  entry.nextAt = now + 30_000
  if (
    !(device?.liveActivities ?? []).some((saved) => saved.activityId === entry.input.activityId)
  ) {
    return
  }
  if (
    !context.registry.setLiveActivities(
      entry.principal.deviceId,
      (device?.liveActivities ?? []).map((saved) =>
        saved.activityId === entry.input.activityId ? { ...saved, sequence } : saved
      )
    )
  ) {
    return
  }
  entry.nextAt = now + 30_000
  try {
    const outcome = await context.gateway.sendLiveActivity({
      schemaVersion: 2,
      overviewId: entry.input.overviewId,
      scopeKey: entry.input.scopeKey,
      sequence,
      event,
      content
    })
    if (outcome === 'sent') {
      entry.sentAt = now
    }
    if (outcome === 'dead' || (outcome === 'sent' && event === 'end')) {
      context.remove()
    } else if (outcome === 'sent') {
      entry.sent = identity
      entry.nextAt = Math.min(
        now + HEARTBEAT_MS,
        entry.expiresAt,
        entry.authoritative ? Infinity : entry.censusAt + 30_000
      )
    }
  } catch {
    entry.nextAt = now + 30_000
  }
}
