import { hoistPreludeCheckpoints } from './prelude-checkpoints'
import type { RecordingScenario, Rejection, ScenarioStep } from './recording-scenario'

export type ReplyPartition = { id: string; reply?: unknown; reject?: Rejection }

/**
 * Only shapes a host can send. `successResponse` always sets `result`, so an absent key means the
 * handler returned undefined and there is no explicit-undefined shape on a JSON wire; `null` is a
 * real result (`linear.getIssue` on a missing issue, and the b2 seed). The GitHub project
 * mutations carry an inner `{ok, error}` envelope whose error is a string or an object. Everything
 * else a client sees is the dispatcher refusing, not knowing the method, or the transport failing.
 */
export function replyPartitions(normal: unknown): ReplyPartition[] {
  return [
    { id: 'normal', reply: { ok: true, result: normal } },
    { id: 'result-absent', reply: { ok: true } },
    { id: 'result-null', reply: { ok: true, result: null } },
    { id: 'inner-ok-missing', reply: { ok: true, result: { error: 'refused' } } },
    {
      id: 'inner-false-string-error',
      reply: { ok: true, result: { ok: false, error: 'inner refused' } }
    },
    {
      id: 'inner-false-object-error',
      reply: { ok: true, result: { ok: false, error: { message: 'inner refused' } } }
    },
    {
      id: 'outer-refused',
      reply: { ok: false, error: { code: 'refused', message: 'outer refused' } }
    },
    {
      id: 'method-not-found',
      reply: { ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
    },
    { id: 'transport-rejection', reject: { message: 'transport failure', deliveryUnknown: true } }
  ]
}

export function driveReplyMatrix(
  base: RecordingScenario,
  request: string,
  normal: unknown
): RecordingScenario[] {
  const sites = base.steps.flatMap((step, index) =>
    'complete' in step && step.complete === request ? [index] : []
  )
  if (sites.length !== 1) {
    throw new Error(`Matrix requires exactly one completion: ${request}`)
  }
  const divergence = sites[0]!
  return hoistPreludeCheckpoints(
    base,
    replyPartitions(normal).map((partition) => ({
      divergence,
      scenario: {
        ...base,
        id: `${base.id}.${partition.id}`,
        steps: base.steps.map((step, index): ScenarioStep =>
          index === divergence && 'complete' in step
            ? {
                complete: request,
                params: step.params,
                ...('reject' in partition
                  ? { reject: partition.reject }
                  : { reply: partition.reply })
              }
            : step
        )
      }
    }))
  )
}
