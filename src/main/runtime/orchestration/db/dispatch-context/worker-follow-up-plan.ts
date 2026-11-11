import type { MessageType } from '../orchestration-records'

type Dispatch = { id: string; status: string; follow_up_of_dispatch_id: string | null }
type Resource = { owner_dispatch_id: string; origin_dispatch_id: string }

export const FOLLOW_UP_MESSAGE_TYPES = ['notice', 'status', 'dispatch', 'handoff'] as const

export type WorkerLineageFacts<D extends Dispatch, R extends Resource> = {
  dispatch: (id: string) => D | undefined
  ownedResource: (id: string) => R | undefined
  formerResource: (id: string) => R | undefined
  followUp: (id: string) => D | undefined
}

export function resolveWorkerLineageFacts<D extends Dispatch, R extends Resource>(
  facts: WorkerLineageFacts<D, R>,
  dispatchId: string,
  cache?: Map<string, { latest: D; resource: R | undefined }>
): { latest: D; resource: R | undefined } | undefined {
  const cached = cache?.get(dispatchId)
  if (cached) {
    return cached
  }
  const addressed = facts.dispatch(dispatchId)
  if (!addressed) {
    return undefined
  }
  let latest = addressed
  const resourceOf = (id: string) => facts.ownedResource(id) ?? facts.formerResource(id)
  const seen = new Set([latest.id])
  const remember = (value: { latest: D; resource: R | undefined }) => {
    for (const id of seen) {
      cache?.set(id, value)
    }
    return value
  }
  // A follow-up that never got a worker continues the nearest one before it that did.
  let resource = resourceOf(latest.id)
  for (let back = addressed; !resource && back.follow_up_of_dispatch_id;) {
    const prior = facts.dispatch(back.follow_up_of_dispatch_id)
    if (!prior || seen.has(prior.id)) {
      break
    }
    seen.add(prior.id)
    back = prior
    resource = resourceOf(prior.id)
  }
  for (;;) {
    const suffix = cache?.get(latest.id)
    if (suffix) {
      return remember({ latest: suffix.latest, resource: suffix.resource ?? resource })
    }
    const transferred = resource && resource.owner_dispatch_id !== latest.id ? resource : undefined
    const next =
      facts.followUp(latest.id) ??
      (transferred ? facts.dispatch(transferred.owner_dispatch_id) : undefined)
    if (!next || seen.has(next.id)) {
      return remember({ latest, resource })
    }
    seen.add(next.id)
    latest = next
    resource = resourceOf(next.id) ?? resource
  }
}

export function selectWorkerFollowUpPlan<D extends Dispatch, R extends Resource>(
  addressed: D | undefined,
  lineage: () => { latest: D; resource: R | undefined } | undefined,
  type: MessageType,
  federated: (id: string) => boolean,
  worker: (id: string) => boolean
):
  | { kind: 'steer'; dispatchId: string }
  | { kind: 'start'; latest: D; resource: R | undefined }
  | undefined {
  const active = (row: D) => row.status === 'pending' || row.status === 'dispatched'
  const resolved = addressed && !active(addressed) ? lineage() : undefined
  if (!resolved) {
    return undefined
  }
  const { latest, resource } = resolved
  if (active(latest)) {
    return { kind: 'steer', dispatchId: latest.id }
  }
  if (
    !FOLLOW_UP_MESSAGE_TYPES.some((followUpType) => followUpType === type) ||
    federated(latest.id) ||
    !worker(resource?.origin_dispatch_id ?? latest.id)
  ) {
    return latest.id === addressed?.id ? undefined : { kind: 'steer', dispatchId: latest.id }
  }
  return { kind: 'start', latest, resource }
}
