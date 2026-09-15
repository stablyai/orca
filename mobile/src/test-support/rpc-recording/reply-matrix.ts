import { hoistPreludeCheckpoints } from './prelude-checkpoints'
import type { RecordingScenario, Rejection, ScenarioStep } from './recording-scenario'

export type ReplyPartition = { id: string; reply?: unknown; reject?: Rejection }

/**
 * Only shapes a host can send. `successResponse` always sets `result`, so an absent key means the
 * handler returned undefined and there is no explicit-undefined shape on a JSON wire; `null` is a
 * real result (`linear.getIssue` on a missing issue, and the b2 seed). The GitHub project
 * mutations carry an inner `{ok, error}` envelope whose error is a string or an object. Everything
 * else a client sees is the dispatcher refusing, not knowing the method, or the transport failing.
 *
 * Refusal and rejection each appear twice, once with a message and once without. A message is what
 * separates the two failure paths a migrated call site has to keep apart: a refusal with none falls
 * back to the screen's copy, a transport drop with none surfaces its empty message verbatim. With
 * only the message-carrying shapes both paths produce the same text, and collapsing them is
 * invisible — which is why every source-control family had a hand-written `*-empty-message`
 * scenario. The partition carries that instead of each migrator remembering to write one.
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
      id: 'outer-refused-no-message',
      reply: { ok: false, error: { code: 'refused', message: '' } }
    },
    {
      id: 'method-not-found',
      reply: { ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
    },
    { id: 'transport-rejection', reject: { message: 'transport failure', deliveryUnknown: true } },
    { id: 'transport-rejection-no-message', reject: { message: '', deliveryUnknown: true } }
  ]
}

/**
 * Every reply the base scenario scripts, as a site the matrix drives.
 *
 * Why all of them and not one: picking the request per family is what let ten families fall out of
 * the matrix without saying so, and there is no property of a scenario that identifies the "real"
 * request — the settings families answer prerequisites before their own read, the chains answer
 * their own steps in order. Driving every completion needs no such judgement and needs no edit when
 * a domain is added. A family that scripts no reply at all cannot be matrixed and throws.
 */
export function replyMatrixSites(base: RecordingScenario): string[] {
  const sites = base.steps.flatMap((step) => ('complete' in step ? [step.complete] : []))

  if (!sites.length) {
    throw new Error(`No scripted reply to drive a matrix over: ${base.id}`)
  }

  const repeated = sites.filter((name, index) => sites.indexOf(name) !== index)

  if (repeated.length) {
    // A repeated name would make the divergence ambiguous; the manifest binds concurrent requests.
    throw new Error(`Matrix sites must be unique: ${base.id} repeats ${repeated.join(', ')}`)
  }

  return sites
}

/** Golden id for one family's matrix at one site, inside the charset `writeGolden` accepts. */
export function replyMatrixGoldenId(family: string, request: string): string {
  return `matrix-${family}-${request}`.toLowerCase().replaceAll('#', '-')
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
            : index > divergence && ('complete' in step || 'bind' in step)
              ? // The diverged reply may have ended the chain, so downstream replies are answered
                // only if the operation asked for them. The sender list records which it did.
                { ...step, optional: true }
              : step
        )
      }
    }))
  )
}
