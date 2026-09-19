import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('lifecycle writer boundary', () => {
  it('keeps production state/status writes behind transitionLifecycleWithDb', () => {
    const root = resolve(__dirname)
    const files = [
      'worker-dispatch/worker-dispatch-outcome.ts',
      'worker-dispatch/worker-dispatch-abandon.ts',
      'worker-dispatch/worker-dispatch-stop.ts',
      'worker-dispatch/federated-worker-start-reconcile.ts',
      'dispatch-context/dispatch-completion.ts',
      'dispatch-context/task-dispatch-reconciliation.ts',
      'decision-gates/decision-gate-store.ts',
      '../context-only-dispatch-release.ts'
    ]
    const directStateWrite =
      /UPDATE\s+(?:worker_dispatches|dispatch_contexts|tasks)[\s\S]{0,180}?SET\s+(?:state|status)\s*=/i
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(source, file).not.toMatch(directStateWrite)
    }
  })
})
