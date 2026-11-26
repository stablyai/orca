import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../../runtime/client'
import { commanderBriefing } from './commander-briefing'

afterEach(() => {
  vi.restoreAllMocks()
})

it('counts 300 tasks without exposing their text and leaves refused decision counts unknown', async () => {
  const client = new RuntimeClient('/tmp/orca-briefing-test')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(client, 'call').mockImplementation(async (method) => {
    const envelope = { id: 'test', ok: true as const, _meta: { runtimeId: 'local' } }
    if (method === 'orchestration.runList') {
      return {
        ...envelope,
        result: { runs: [{ id: 'run-a', objective: 'Ship checkout' }], nextCursor: 'more' }
      }
    }
    if (method === 'orchestration.taskList') {
      return {
        ...envelope,
        result: {
          tasks: Array.from({ length: 300 }, (_, i) => ({
            id: `task-${i}`,
            status: i === 0 ? 'blocked' : 'completed',
            spec: 'long internal task body'
          }))
        }
      }
    }
    throw new Error('Decision data unavailable')
  })
  await commanderBriefing({ client, flags: new Map(), cwd: '/tmp', json: true })
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({
    ok: true,
    result: {
      goals: [
        {
          runId: 'run-a',
          objective: 'Ship checkout',
          taskCounts: { blocked: 1, completed: 299 },
          pendingDecisions: null,
          decisions: null,
          gateReadError: 'Decision data unavailable'
        }
      ],
      nextCursor: 'more'
    }
  })
})
