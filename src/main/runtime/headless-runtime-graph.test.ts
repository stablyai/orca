import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('is published by orcad before its RPC server accepts a client', () => {
    // Why a source check: orcad's startup needs a real profile store and pty host to run.
    const entry = readFileSync(join(import.meta.dirname, '../orcad/orcad-entry.ts'), 'utf8')
    const published = entry.indexOf('publishHeadlessRuntimeGraph(runtime)')
    expect(published).toBeGreaterThan(-1)
    expect(published).toBeLessThan(entry.indexOf('await rpc.start()'))
  })
})
