// SPIKE, not for merge: the operations the invariant harness draws, and its shrinker.

// Parties 0,1 are agents a question is sent to; 2 is the coordinator reading the Run's mail.
export const RECEIVERS = 3
export const COORDINATOR = 2

export type Op =
  | { op: 'ask'; to: number }
  | { op: 'workerAsk' }
  | { op: 'status'; to: number }
  | { op: 'statusToWorker'; worker: number }
  | { op: 'deliver'; to: number }
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
  | { op: 'pause'; who: number }
  | { op: 'unpause'; who: number }
  | { op: 'delete'; who: number }
  | { op: 'unbind' }
  | { op: 'unpair'; who: number }
  | { op: 'startHelper'; worker: number }
  | { op: 'crash' }
  | { op: 'lostEdgeThenCrash'; inner: Op }

export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

export function randomOp(random: () => number, depth = 0): Op {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const who = Math.floor(random() * RECEIVERS)
  const to = Math.floor(random() * 2)
  const worker = Math.floor(random() * 4)
  const kind = pick([
    'ask',
    'ask',
    'ask',
    'workerAsk',
    'workerAsk',
    'status',
    'statusToWorker',
    'deliver',
    'deliver',
    'deliver',
    'deliver',
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
    'pause',
    'unpause',
    'delete',
    'unbind',
    'crash',
    'lostEdgeThenCrash',
    'unpair',
    'startHelper',
    'startHelper'
  ] as const)
  switch (kind) {
    case 'ask':
    case 'status':
      return { op: kind, to }
    case 'workerAsk':
    case 'unbind':
    case 'crash':
      return { op: kind }
    case 'deliver':
    case 'shellCheck':
      return { op: kind, to: who }
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
    default:
      return { op: kind, who }
  }
}

export async function shrink(
  ops: Op[],
  kind: string,
  runSequence: (ops: Op[]) => Promise<{ kind: string }[]>
): Promise<Op[]> {
  let current = ops
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length; i++) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)]
      const violations = await runSequence(candidate)
      if (violations.some((v) => v.kind === kind)) {
        current = candidate
        changed = true
        break
      }
    }
  }
  return current
}
