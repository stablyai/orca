import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../shared/automations-types'
import { paginateAutomationRuns } from '../shared/automation-run-cursor'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../shared/remote-runtime/remote-runtime-memory-limits'
import {
  AUTOMATION_RUNS_PAGE_SIZE,
  readAllAutomationRuns,
  readAutomationRunsPage
} from './automation-runs-paging'
import { RuntimeClientError } from './runtime-client'

function run(index: number, snapshotBytes = 0): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: paging reads only id, createdAt and size.
  return {
    id: `run-${String(index).padStart(4, '0')}`,
    automationId: 'auto-1',
    createdAt: 1_000_000 - index,
    outputSnapshot: { content: 'x'.repeat(snapshotBytes) }
  } as unknown as AutomationRun
}

function pairedHost(runs: AutomationRun[], options: { pages: boolean } = { pages: true }) {
  return vi.fn(async (params: { automationId?: string; limit?: number; cursor?: string }) => {
    const result =
      options.pages && (params.limit !== undefined || params.cursor !== undefined)
        ? paginateAutomationRuns(runs, params.limit, params.cursor)
        : { runs }
    if (JSON.stringify(result).length > REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES) {
      throw new RuntimeClientError('reply_too_large', 'The result is larger than 4.0 MB.')
    }
    return { id: 'r', ok: true as const, result, _meta: { runtimeId: 'host' } }
  })
}

describe('readAllAutomationRuns', () => {
  it('reads a history larger than one remote reply, in order and without gaps', async () => {
    const runs = Array.from({ length: 430 }, (_, index) => run(index, 23_000))
    const host = pairedHost(runs)
    const result = await readAllAutomationRuns(host, undefined)
    expect(result.result.runs.map((entry) => entry.id)).toEqual(runs.map((entry) => entry.id))
    expect(host.mock.calls[0][0]).toEqual({ limit: AUTOMATION_RUNS_PAGE_SIZE })
  })

  it('shrinks the page when even one page is too large for the reply', async () => {
    const runs = Array.from({ length: 40 }, (_, index) => run(index, 400_000))
    const host = pairedHost(runs)
    const result = await readAllAutomationRuns(host, 'auto-1')
    expect(result.result.runs.map((entry) => entry.id)).toEqual(runs.map((entry) => entry.id))
    expect(host.mock.calls[0][0]).toMatchObject({ automationId: 'auto-1', limit: 25 })
    expect(host.mock.calls.some(([params]) => params.limit === 6)).toBe(true)
  })

  it('stops after one reply from a host that predates paging', async () => {
    const runs = Array.from({ length: 3 }, (_, index) => run(index))
    const host = pairedHost(runs, { pages: false })
    const result = await readAllAutomationRuns(host, undefined)
    expect(result.result.runs).toEqual(runs)
    expect(host).toHaveBeenCalledTimes(1)
  })
})

describe('readAutomationRunsPage', () => {
  it('returns one page and the cursor for the next', async () => {
    const runs = Array.from({ length: 30 }, (_, index) => run(index))
    const page = await readAutomationRunsPage(pairedHost(runs), { limit: 10 })
    expect(page.result.runs).toEqual(runs.slice(0, 10))
    expect(page.result.nextCursor).toBe(`${runs[9].createdAt}:${runs[9].id}`)
  })

  it('surfaces a reply that is too large even for a single run', async () => {
    const host = pairedHost([run(0, 5_000_000)])
    await expect(readAutomationRunsPage(host, { limit: 4 })).rejects.toMatchObject({
      code: 'reply_too_large'
    })
    expect(host).toHaveBeenCalledTimes(3)
  })
})
