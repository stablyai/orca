import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { publishHeadlessRuntimeGraph } from './headless-runtime-graph'

describe('headless runtime graph', () => {
  it('lets a session tab inventory settle on a host no renderer publishes for', async () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory census reads only listProcesses.
    runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
    publishHeadlessRuntimeGraph(runtime)

    await expect(runtime.listAllMobileSessionTabsInventory()).resolves.toEqual({
      snapshots: [],
      authoritative: true
    })
  })
})
