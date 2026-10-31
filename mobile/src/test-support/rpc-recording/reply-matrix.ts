import { hoistPreludeCheckpoints } from './prelude-checkpoints'
import type { RecordingScenario, Rejection, ScenarioStep } from './recording-scenario'

export type ReplyPartition = { id: string; reply?: unknown; reject?: Rejection }

// Drive only wire-representable shapes; JSON cannot carry explicit undefined.
// Include message-free refusals/rejections because their different fallback copy exposes collapsed failure paths.
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

// Frames have no request promise, so transport rejection partitions do not apply.
// Stamp success frames streaming:true to reach the registry; non-streaming unary closers need separate flag coverage.
function frameReplyPartitions(normal: unknown): ReplyPartition[] {
  return replyPartitions(normal).flatMap((partition) => {
    const envelope = successEnvelope(partition.reply)
    return 'reject' in partition
      ? []
      : [{ ...partition, reply: envelope ? { ...envelope, streaming: true } : partition.reply }]
  })
}

function successEnvelope(reply: unknown): Record<string, unknown> | null {
  return reply !== null && typeof reply === 'object' && 'ok' in reply && reply.ok === true
    ? { ...reply }
    : null
}

type MatrixSite = { id: string; index: number; reply: unknown; bridgeOnly: boolean }

// Matrix every reply, including prerequisites, so new families cannot lose coverage through hand-selected sites.
// Name stream frames by subscribe payload and occurrence to distinguish ready/events/end.
export function matrixSites(base: RecordingScenario): MatrixSite[] {
  const frames = new Map<string, number>()
  return base.steps.flatMap((step, index) => {
    if ('complete' in step) {
      return [
        {
          id: step.site ?? step.complete,
          index,
          reply: step.reply,
          bridgeOnly: step.bridgeSite === true
        }
      ]
    }
    if ('frame' in step) {
      const occurrence = (frames.get(step.frame) ?? 0) + 1
      frames.set(step.frame, occurrence)
      return [
        {
          id: step.site ?? `${step.frame}@${occurrence}`,
          index,
          reply: step.reply,
          bridgeOnly: false
        }
      ]
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
    base.lineage
      ? {
          ...base,
          lineage: {
            ...base.lineage,
            site: request,
            domain: sites[0]!.bridgeOnly ? 'bridge-only' : base.lineage.domain
          }
        }
      : base,
    partitions.map((partition) => {
      const branch = base.replyBranches?.find(
        (entry) => entry.site === request && entry.partitions.includes(partition.id)
      )
      return {
        divergence,
        scenario: {
          ...base,
          id: `${base.id}.${partition.id}`,
          ...(branch
            ? {
                bridgeOperations: base.bridgeOperations?.filter(
                  (entry) => entry.request !== branch.request
                )
              }
            : {}),
          ...(base.lineage
            ? {
                lineage: {
                  ...base.lineage,
                  site: request,
                  partition: partition.id,
                  domain: sites[0]!.bridgeOnly ? ('bridge-only' as const) : base.lineage.domain
                }
              }
            : {}),
          steps: base.steps.flatMap((original, index): ScenarioStep[] => {
            if (branch && original.bridgeSite && original.site === `${branch.request}.native-1`) {
              return []
            }
            const step =
              branch && 'complete' in original && original.site === branch.request
                ? {
                    ...original,
                    params: branch.params,
                    complete:
                      base.lineage?.mode === 'bridge'
                        ? `${branch.request}.native-1`
                        : branch.request
                  }
                : original
            return [
              ((): ScenarioStep => {
                if (index > divergence) {
                  // After divergence, answer later requests only if sent; frames remain deliverable through the registry.
                  return 'complete' in step || 'bind' in step ? { ...step, optional: true } : step
                }
                if (index !== divergence) {
                  return step
                }
                if ('frame' in step) {
                  return { ...step, reply: partition.reply }
                }
                if ('complete' in step) {
                  return {
                    ...step,
                    reply: undefined,
                    reject: undefined,
                    ...('reject' in partition
                      ? { reject: partition.reject }
                      : { reply: partition.reply })
                  }
                }
                return step
              })()
            ]
          })
        }
      }
    })
  )
}
