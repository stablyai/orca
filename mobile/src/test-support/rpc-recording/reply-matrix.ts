import { hoistPreludeCheckpoints } from './prelude-checkpoints'
import type { RecordingScenario, Rejection, ScenarioStep } from './recording-scenario'

export type ReplyPartition = { id: string; reply?: unknown; reject?: Rejection }
export function replyPartitions(
  normal: unknown,
  consumedFields: readonly string[][]
): ReplyPartition[] {
  const rows: ReplyPartition[] = [
    { id: 'normal', reply: { ok: true, result: normal } },
    { id: 'result-absent', reply: { ok: true } }
  ]
  for (const [id, result] of Object.entries({
    undefined,
    null: null,
    empty: {},
    true: true,
    false: false,
    zero: 0,
    string: 'value',
    array: []
  })) {
    rows.push({ id: `result-${id}`, reply: { ok: true, result } })
  }
  rows.push({ id: 'inner-ok-missing', reply: { ok: true, result: { error: 'refused' } } })
  for (const [id, ok] of Object.entries({
    undefined,
    null: null,
    false: false,
    true: true,
    truthy: 'yes'
  })) {
    for (const [errorKind, error] of Object.entries({
      string: 'inner refused',
      object: { message: 'inner refused' }
    })) {
      rows.push({
        id: `inner-${id}-${errorKind}-error`,
        reply: { ok: true, result: { ok, error } }
      })
    }
  }
  rows.push(
    {
      id: 'outer-refused',
      reply: { ok: false, error: { code: 'refused', message: 'outer refused' } }
    },
    {
      id: 'method-not-found',
      reply: { ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
    },
    { id: 'transport-rejection', reject: { message: 'transport failure', deliveryUnknown: true } }
  )
  const objectReplies = rows.filter((row) => {
    const envelope = row.reply as { ok?: boolean; result?: unknown } | undefined
    return (
      envelope?.ok === true &&
      envelope.result !== null &&
      typeof envelope.result === 'object' &&
      !Array.isArray(envelope.result)
    )
  })
  for (const row of objectReplies) {
    for (const field of consumedFields) {
      for (const boundary of ['missing', 'null', 'wrong-type'] as const) {
        const result = structuredClone((row.reply as { result: Record<string, unknown> }).result)
        let parent = result
        for (const part of field.slice(0, -1)) {
          if (
            parent[part] === null ||
            typeof parent[part] !== 'object' ||
            Array.isArray(parent[part])
          ) {
            parent[part] = {}
          }
          parent = parent[part] as Record<string, unknown>
        }
        if (boundary === 'missing') {
          delete parent[field.at(-1)!]
        } else {
          parent[field.at(-1)!] = boundary === 'null' ? null : 42
        }
        rows.push({
          id: `${row.id}.field-${field.join('-')}-${boundary}`,
          reply: { ok: true, result }
        })
      }
    }
  }
  return rows
}

export function driveReplyMatrix(
  base: RecordingScenario,
  request: string,
  normal: unknown,
  fields: readonly string[][]
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
    replyPartitions(normal, fields).map((partition) => ({
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
