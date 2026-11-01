import { z } from 'zod'
import type { OrchestrationDb } from './db'
import { AGENT_TYPE_MAX_LENGTH } from '../../../shared/agent-status-field-normalization'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { salvagedOptional } from '../../../shared/zod-salvage'

const object = z.record(z.string(), z.unknown())
const selection = z.object({
  agent: salvagedOptional('agent', z.string().min(1).max(AGENT_TYPE_MAX_LENGTH).nullable()),
  model: salvagedOptional('model', z.string().nullable()),
  effort: salvagedOptional('effort', z.string().nullable())
})
const launch = z.object({
  requested: salvagedOptional('requested', selection),
  effective: salvagedOptional('effective', selection)
})

/** Display knowledge is independent of executable launch choices and independently salvageable. */
export function workerLaunchAgent(value: unknown): string | null {
  const parsed = launch.safeParse(value)
  return parsed.success
    ? parsed.data.effective?.agent || parsed.data.requested?.agent || null
    : null
}

function startOptions(json: string): Record<string, unknown> {
  try {
    return object.parse(JSON.parse(json))
  } catch {
    return {}
  }
}

export function workerStartOptionsAgent(json: string): string | null {
  const options = startOptions(json)
  return workerLaunchAgent(options.launch) || (isTuiAgent(options.agent) ? options.agent : null)
}

/** Enrich the existing launch concept without rewriting the person's selector or preferences. */
export function mergeWorkerLaunchObservation(json: string, observation: unknown): string {
  let options: Record<string, unknown>
  try {
    options = object.parse(JSON.parse(json))
  } catch {
    return json
  }
  const decoded = launch.safeParse(observation)
  if (!decoded.success) {
    return json
  }
  const saved = object.safeParse(options.launch)
  const previous = saved.success ? saved.data : {}
  const requested = object.safeParse(previous.requested)
  const requestedFields = requested.success ? requested.data : {}
  const requestedAgent = selection.safeParse(requestedFields)
  const acquired = decoded.data.requested?.agent
  const effective = decoded.data.effective
  const priorEffective = object.safeParse(previous.effective)
  const effectiveBefore = priorEffective.success ? priorEffective.data : {}
  const effectiveFields = effective
    ? Object.fromEntries(
        Object.entries(effective).filter(
          ([key, value]) => value !== undefined && (value !== null || effectiveBefore[key] == null)
        )
      )
    : {}
  return JSON.stringify({
    ...options,
    launch: {
      ...previous,
      ...(acquired && !(requestedAgent.success && requestedAgent.data.agent)
        ? { requested: { ...requestedFields, agent: acquired } }
        : {}),
      ...(Object.keys(effectiveFields).length
        ? {
            effective: {
              ...effectiveBefore,
              ...effectiveFields
            }
          }
        : {})
    }
  })
}

export function logWorkerLaunchObservationFailure(error: unknown): void {
  try {
    console.warn('[orchestration] worker launch observation failed', error)
  } catch {
    // Display bookkeeping cannot change a user's action.
  }
}

export function recordWorkerLaunchObservation(
  db: OrchestrationDb,
  dispatchId: string,
  observation: unknown
): void {
  try {
    db.retainWorkerLaunchObservation(dispatchId, observation)
  } catch (error) {
    logWorkerLaunchObservationFailure(error)
  }
}
