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
 * The partitions that apply at a frame: nine of the eleven.
 *
 * A frame is a whole host response handed to the real stream registry, and the two transport
 * rejections are the shapes a *request promise* fails with — a subscription holds no promise, so
 * there is nothing at a frame for them to reject. Everything else a host can put on a stream id is
 * here, including the unary envelopes: the dispatcher sends exactly those once a streaming handler
 * returns, and each drives a real branch of the registry rather than a shape invented for symmetry.
 *
 * Every success partition is stamped `streaming: true`, because that flag is what routes a response
 * to the open stream rather than to a retired request id. Without it `normal` would be a different
 * shape from the frame it replays, and a success control that is not one. A base frame that scripts
 * a non-streaming unary closer is therefore unsupported here: no scenario writes one, and its matrix
 * would need the flag varied per partition rather than stamped.
 */
function frameReplyPartitions(normal: unknown): ReplyPartition[] {
  return replyPartitions(normal).flatMap((partition) => {
    const envelope = successEnvelope(partition.reply)
    return 'reject' in partition
      ? []
      : [{ ...partition, reply: envelope ? { ...envelope, streaming: true } : partition.reply }]
  })
}

/** A success envelope, spreadable: only one carries `streaming`, a refusal has no result to stream. */
function successEnvelope(reply: unknown): Record<string, unknown> | null {
  return reply !== null && typeof reply === 'object' && 'ok' in reply && reply.ok === true
    ? { ...reply }
    : null
}

/** One reply a base scenario scripts, as a site the matrix drives. */
type MatrixSite = { id: string; index: number; reply: unknown }

/**
 * Every reply the base scenario scripts, in order.
 *
 * Why all of them and not one: picking the request per family is what let ten families fall out of
 * the matrix without saying so, and there is no property of a scenario that identifies the "real"
 * request — the settings families answer prerequisites before their own read, the chains answer
 * their own steps in order. Driving every reply needs no such judgement and needs no edit when a
 * domain is added. A family that scripts no reply at all cannot be matrixed and throws.
 *
 * A completion is named by its request. A frame is named by the subscribe payload it arrives on
 * *and its occurrence*, because one subscription carries many frames — `ready`, then events, then
 * `end` — so the payload name alone repeats and would make the divergence ambiguous.
 */
export function matrixSites(base: RecordingScenario): MatrixSite[] {
  const frames = new Map<string, number>()
  return base.steps.flatMap((step, index) => {
    if ('complete' in step) {
      return [{ id: step.complete, index, reply: step.reply }]
    }
    if ('frame' in step) {
      const occurrence = (frames.get(step.frame) ?? 0) + 1
      frames.set(step.frame, occurrence)
      return [{ id: `${step.frame}@${occurrence}`, index, reply: step.reply }]
    }
    return []
  })
}

export function replyMatrixSites(base: RecordingScenario): string[] {
  const sites = matrixSites(base).map((site) => site.id)
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
  return `matrix-${family}-${request}`.toLowerCase().replaceAll('#', '-').replaceAll('@', '-')
}

export function driveReplyMatrix(
  base: RecordingScenario,
  request: string,
  normal: unknown
): RecordingScenario[] {
  const sites = matrixSites(base).filter((site) => site.id === request)
  if (sites.length !== 1) {
    throw new Error(`Matrix requires exactly one reply at: ${request}`)
  }
  const { index: divergence } = sites[0]!
  const framed = 'frame' in base.steps[divergence]!
  const partitions = framed ? frameReplyPartitions(normal) : replyPartitions(normal)
  return hoistPreludeCheckpoints(
    base,
    partitions.map((partition) => ({
      divergence,
      scenario: {
        ...base,
        id: `${base.id}.${partition.id}`,
        steps: base.steps.map((step, index): ScenarioStep => {
          if (index > divergence) {
            // The diverged reply may have ended the chain, so downstream replies are answered only
            // if the operation asked. The sender list records which.
            return 'complete' in step || 'bind' in step ? { ...step, optional: true } : step
          }
          if (index !== divergence) {
            return step
          }
          if ('frame' in step) {
            return { frame: step.frame, params: step.params, reply: partition.reply }
          }
          if ('complete' in step) {
            return {
              complete: step.complete,
              params: step.params,
              ...('reject' in partition ? { reject: partition.reject } : { reply: partition.reply })
            }
          }
          return step
        })
      }
    }))
  )
}
