import { describe, expect, it } from 'vitest'
import { listProcessesWithHostScopeFromRuntimeController } from './inventory-operations'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/**
 * `hostScopeCensusIsComplete` discounts a `runtime:` host in `omittedHostIds` on the strength of
 * one fact about this process: it has no paired-runtime PTY provider, so it never queried that
 * host and never owed it coverage. This file pins the producer side of that fact: this process
 * queries only its own PTYs, so a `runtime:` spelling here is the breakage that matters.
 */
describe('the hosts a PTY inventory can report having queried', () => {
  it('emits only this machine, never a paired-runtime host', async () => {
    const { hostIds } = await listProcessesWithHostScopeFromRuntimeController({
      runtime: null
    } as unknown as PtyRuntimeControllerDeps)

    expect(hostIds).toEqual(['local'])
  })
})
