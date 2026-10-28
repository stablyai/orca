import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunEventsPage } from '../../shared/orchestration-run-events'
import { dispatch } from '../dispatch'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'

afterEach(() => vi.restoreAllMocks())

describe('orchestration run-events CLI', () => {
  it('prints incomplete coverage, event order and a continuation; JSON preserves structured data', async () => {
    const page: RunEventsPage = {
      runId: 'run_1',
      coverage: { completeFromCreation: false, recordedSince: '2026-10-28T10:00:00Z' },
      events: [
        {
          sequence: 42,
          runId: 'run_1',
          entityId: 'dispatch_1',
          taskId: 'task_1',
          dispatchId: 'dispatch_1',
          kind: 'dispatch.status_changed',
          recordedAt: '2026-10-28T10:01:00Z',
          data: { previousStatus: 'dispatched', status: 'failed' }
        }
      ],
      nextCursor: 'next-page'
    }
    const client = new RuntimeClient()
    const call = vi
      .spyOn(client, 'call')
      .mockResolvedValue({ id: 'request', ok: true, result: page, _meta: { runtimeId: 'host_1' } })
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const context = {
      client,
      cwd: process.cwd(),
      json: false,
      flags: new Map([
        ['id', 'run_1'],
        ['limit', '1'],
        ['cursor', 'previous-page']
      ])
    }
    await dispatch(['orchestration', 'run-events'], context)
    expect(output).toHaveBeenLastCalledWith(
      'Earlier history is incomplete. Continuous recording since 2026-10-28T10:00:00Z.\n' +
        '42 2026-10-28T10:01:00Z dispatch.status_changed dispatch_1 dispatched -> failed\n' +
        'More events: --cursor next-page'
    )
    expect(call).toHaveBeenCalledWith('orchestration.runEvents', {
      id: 'run_1',
      limit: 1,
      cursor: 'previous-page'
    })
    await dispatch(['orchestration', 'run-events'], { ...context, json: true })
    const lastOutput: unknown = output.mock.lastCall?.[0]
    if (typeof lastOutput !== 'string') {
      throw new Error('Expected JSON output')
    }
    expect(JSON.parse(lastOutput)).toMatchObject({
      ok: true,
      result: page,
      _meta: { runtimeId: 'host_1' }
    })
  })

  it('names the required host update instead of reporting an empty history', async () => {
    const client = new RuntimeClient()
    vi.spyOn(client, 'call').mockRejectedValue(
      new RuntimeClientError('method_not_found', 'Unknown method')
    )
    await expect(
      dispatch(['orchestration', 'run-events'], {
        client,
        cwd: process.cwd(),
        flags: new Map([['id', 'run_1']]),
        json: true
      })
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('Update Orca on the host')
    })
  })
})
