import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { orchestrationTestContext } from '../orchestration-handler-test-context'

const HUGE = 'x'.repeat(10_000)
// check delivers mail and gate-list asks the question, so those bodies print whole; inbox previews them.
const CONTENT = 'c'.repeat(10_000)
const MAX_ROW_CHARS = 500
const MAX_PREVIEW_CHARS = 250

const message = {
  id: 'msg_1',
  from_handle: 'dispatch:ctx_1',
  to_handle: 'run:run_1',
  subject: 'Done',
  body: HUGE,
  type: 'worker_done',
  priority: 'normal',
  read: 0,
  thread_id: 'msg_1',
  payload: JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1', notes: HUGE }),
  created_at: '2026-10-31T00:00:00Z'
}

const LISTS: [string, [string, string][], string, unknown][] = [
  [
    'task-list',
    [['run', 'run_1']],
    'tasks',
    {
      tasks: [
        { id: 'task_1', spec: HUGE, status: 'completed', result: HUGE, dispatch_id: 'ctx_1' }
      ],
      count: 1
    }
  ],
  [
    'worker-list',
    [['run', 'run_1']],
    'workers',
    {
      workers: [
        {
          dispatchId: 'ctx_1',
          taskId: 'task_1',
          runId: 'run_1',
          workerState: 'failed',
          dispatchStatus: 'failed',
          agentTerminalHandle: 'term_1',
          terminalState: 'released',
          lastError: HUGE,
          output: HUGE,
          projection: {
            host: { id: 'local' },
            stage: { activity: 'failed' },
            liveness: { verdict: 'exited' },
            nextAction: { argv: [] },
            description: HUGE
          }
        }
      ],
      counts: { released: 1 },
      page: { hasMore: false, nextCursor: null, total: 1 }
    }
  ],
  [
    'gate-list',
    [['run', 'run_1']],
    'gates',
    {
      gates: [
        {
          id: 'gate_1',
          task_id: 'task_1',
          question: CONTENT,
          options: '["yes","no"]',
          status: 'resolved',
          resolution: HUGE
        }
      ],
      count: 1
    }
  ],
  [
    'run-list',
    [],
    'runs',
    { runs: [{ id: 'run_1', objective: HUGE, legacy: 0 }], nextCursor: null }
  ],
  ['inbox', [], 'messages', { messages: [message], count: 1 }],
  [
    'check',
    [['run', 'run_1']],
    'messages',
    {
      runId: 'run_1',
      deliveryId: 'delivery_1',
      deliveryAcknowledged: true,
      messages: [{ ...message, body: CONTENT, payload: CONTENT }],
      count: 1
    }
  ]
]

async function printed(command: string, flags: [string, string][], result: unknown, json: boolean) {
  const callMock = vi.fn().mockResolvedValue({ id: 'req_1', ok: true, result, _meta: {} })
  const log = vi
    .spyOn(console, 'log')
    .mockClear()
    .mockImplementation(() => {})
  await ORCHESTRATION_HANDLERS[`orchestration ${command}`](
    orchestrationTestContext(callMock, new Map(flags), json)
  )
  return log.mock.calls.map(([line]) => String(line)).join('\n')
}

describe('concise orchestration list output', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each(LISTS)(
    'keeps each %s row short when stored text is huge',
    async (command, flags, key, result) => {
      const rawText = await printed(command, flags, result, false)
      const json: { result: Record<string, { body?: string }[]> } = JSON.parse(
        await printed(command, flags, result, true)
      )
      const items = json.result[key]
      if (command === 'check') {
        expect(rawText).toContain(CONTENT)
        expect(items[0]?.body).toBe(CONTENT)
      } else {
        for (const item of items) {
          expect(item.body?.length ?? 0).toBeLessThanOrEqual(MAX_PREVIEW_CHARS)
        }
      }
      const rows = [rawText, ...items.map((row) => JSON.stringify(row))].flatMap((output) =>
        output.replaceAll(CONTENT, '').split('\n')
      )
      expect(rows.length).toBeGreaterThan(1)
      for (const row of rows) {
        expect(row.length).toBeLessThan(MAX_ROW_CHARS)
      }
    }
  )
})
