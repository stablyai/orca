// The operations the agent-question invariant test draws at random, and its shrinker.

/** Agents 0 and 1 are asked questions; agent 2 only sends status mail and starts no work. */
export const RECEIVERS = 3

export type HandoverEnd = 'turn' | 'queued' | 'refused' | 'stuck'

export type Op =
  | { op: 'ask'; to: number }
  | { op: 'status'; to: number }
  | { op: 'statusToWorker'; worker: number }
  | { op: 'deliver'; to: number }
  | { op: 'handover'; to: number }
  | { op: 'handoverEnds'; to: number; end: HandoverEnd }
  | { op: 'shellCheck'; to: number }
  | { op: 'reply'; by: number; pick: number }
  | { op: 'rest'; who: number }
  | { op: 'prompt'; who: number }
  | { op: 'resume'; who: number }
  | { op: 'close'; who: number }
  | { op: 'startLinked'; by: number; pick: number }
  | { op: 'workerReady'; worker: number }
  | { op: 'workerRest'; worker: number }
  | { op: 'workerWake'; worker: number }
  | { op: 'workerEnd'; worker: number; failed: boolean }
  | { op: 'startHelper'; worker: number }
  | { op: 'pause'; who: number }
  | { op: 'unpause'; who: number }
  | { op: 'delete'; who: number }
  | { op: 'crash' }
  | { op: 'lostEdgeThenCrash'; inner: Op }

export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const WEIGHTED = [
  'ask',
  'ask',
  'ask',
  'status',
  'statusToWorker',
  'deliver',
  'deliver',
  'deliver',
  'handover',
  'handover',
  'handoverEnds',
  'handoverEnds',
  'shellCheck',
  'reply',
  'reply',
  'rest',
  'rest',
  'rest',
  'prompt',
  'resume',
  'close',
  'startLinked',
  'startLinked',
  'workerReady',
  'workerReady',
  'workerRest',
  'workerWake',
  'workerEnd',
  'workerEnd',
  'startHelper',
  'pause',
  'unpause',
  'delete',
  'crash',
  'lostEdgeThenCrash'
] as const

const HANDOVER_ENDS: readonly HandoverEnd[] = ['turn', 'queued', 'refused', 'stuck']

export function randomOp(random: () => number, depth = 0): Op {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const who = Math.floor(random() * RECEIVERS)
  const to = Math.floor(random() * 2)
  const worker = Math.floor(random() * 4)
  const kind = pick(WEIGHTED)
  switch (kind) {
    case 'ask':
    case 'status':
    case 'deliver':
    case 'handover':
    case 'shellCheck':
      return { op: kind, to: kind === 'ask' ? to : who }
    case 'handoverEnds':
      return { op: kind, to: who, end: pick(HANDOVER_ENDS) }
    case 'crash':
      return { op: kind }
    case 'reply':
    case 'startLinked':
      return { op: kind, by: who, pick: Math.floor(random() * 3) }
    case 'statusToWorker':
    case 'startHelper':
    case 'workerReady':
    case 'workerRest':
    case 'workerWake':
      return { op: kind, worker }
    case 'workerEnd':
      return { op: kind, worker, failed: random() < 0.3 }
    case 'lostEdgeThenCrash':
      return depth > 0 ? { op: 'crash' } : { op: kind, inner: randomOp(random, depth + 1) }
    case 'rest':
    case 'prompt':
    case 'resume':
    case 'close':
    case 'pause':
    case 'unpause':
    case 'delete':
      return { op: kind, who }
  }
}

/** Drops one op at a time while the same kind of violation still happens. */
export async function shrink(
  ops: Op[],
  kind: string,
  runSequence: (ops: Op[]) => Promise<{ kind: string }[]>
): Promise<Op[]> {
  let current = ops
  for (let i = 0; i < current.length;) {
    const candidate = [...current.slice(0, i), ...current.slice(i + 1)]
    if ((await runSequence(candidate)).some((violation) => violation.kind === kind)) {
      current = candidate
    } else {
      i++
    }
  }
  return current
}
