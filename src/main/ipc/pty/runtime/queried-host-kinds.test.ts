import { describe, expect, it } from 'vitest'
import { listProcessesWithHostScopeFromRuntimeController } from './inventory-operations'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/** Inventory coverage must name only queried hosts; this process has no paired-runtime provider to query runtime: hosts. */
describe('the hosts a PTY inventory can report having queried', () => {
  it('emits only this machine, never a paired-runtime host', async () => {
    const { hostIds } = await listProcessesWithHostScopeFromRuntimeController({
      runtime: null
    } as unknown as PtyRuntimeControllerDeps)

    expect(hostIds).toEqual(['local'])
  })
})
