import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

type WorkerListResponse = {
  result: {
    workers: {
      dispatchId: string
      taskId: string
      runId: string
      workerState: string
      dispatchStatus: string
      agentTerminalHandle: string | null
      terminalState: string | null
      resource: unknown
      projection?: Record<string, unknown>
    }[]
    counts: Record<string, number>
    page: { total: number; hasMore: boolean; nextCursor: string | null }
  }
}

function projection(heartbeat?: {
  state: string
  ageSeconds?: number | null
}): Record<string, unknown> {
  return {
    provider: { id: 'claude', model: 'opus' },
    host: { id: 'local' },
    workspace: { id: 'ws_1' },
    stage: { activity: 'working' },
    liveness: { verdict: 'unverifiable' },
    ...(heartbeat ? { heartbeat } : {}),
    nextAction: { argv: [] },
    attention: { categories: [] }
  }
}

async function renderWorkerList(response: WorkerListResponse): Promise<string | undefined> {
  callMock.mockResolvedValue(response)
  await ORCHESTRATION_HANDLERS['orchestration worker-list']({
    flags: new Map<string, string | boolean>(),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
  const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
    | ((result: WorkerListResponse['result']) => string)
    | undefined
  return formatter?.(response.result)
}

function workerRow(heartbeat?: { state: string; ageSeconds?: number | null }): WorkerListResponse {
  return {
    result: {
      workers: [
        {
          dispatchId: 'ctx_1',
          taskId: 'task_1',
          runId: 'run_1',
          workerState: 'running',
          dispatchStatus: 'dispatched',
          agentTerminalHandle: 'term_1',
          terminalState: 'active',
          resource: null,
          projection: projection(heartbeat)
        }
      ],
      counts: { active: 1 },
      page: { total: 1, hasMore: false, nextCursor: null }
    }
  }
}

describe('orchestration worker-list heartbeat line', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  afterEach(() => {
    vi.mocked(printResult).mockReset()
  })

  it('prints the freshness beside the liveness verdict, not instead of it', async () => {
    const output = await renderWorkerList(workerRow({ state: 'stale', ageSeconds: 2_580 }))
    expect(output?.split('\n')[0]).toBe(
      'ctx_1 task=task_1 [running/working] attention=none liveness=unverifiable heartbeat=stale (43m) provider=claude/opus host=local workspace=ws_1 terminal=active next=none'
    )
  })

  // Why: `stale` alone cannot separate a lane 11 minutes quiet from one quiet since yesterday,
  // which is the whole decision the coordinator reads this line for.
  it('renders the measured age for a fresh heartbeat too', async () => {
    const output = await renderWorkerList(workerRow({ state: 'fresh', ageSeconds: 125 }))
    expect(output).toContain('heartbeat=fresh (2m)')
  })

  it('prints none for a Dispatch that has never reported', async () => {
    const output = await renderWorkerList(workerRow({ state: 'none', ageSeconds: null }))
    expect(output).toContain('liveness=unverifiable heartbeat=none provider=claude/opus')
    expect(output).not.toContain('heartbeat=none (')
  })

  // Why: a stored arrival stamp nothing can parse is corruption; it measures no age and must not
  // read as silence.
  it('prints unreadable without an age', async () => {
    const output = await renderWorkerList(workerRow({ state: 'unreadable', ageSeconds: null }))
    expect(output).toContain('liveness=unverifiable heartbeat=unreadable provider=claude/opus')
  })

  // Why: a paired host that publishes the state but not the age is still telling the truth about
  // the state; inventing an age there would state a measurement nobody took.
  it('prints the bare state when the host published no age', async () => {
    const output = await renderWorkerList(workerRow({ state: 'stale' }))
    expect(output).toContain('liveness=unverifiable heartbeat=stale provider=claude/opus')
  })

  // Why: a paired host that predates the field publishes no heartbeat at all, and inventing a
  // segment there would state a freshness nobody measured.
  it('omits the segment when the host published no freshness', async () => {
    const output = await renderWorkerList(workerRow())
    expect(output).toContain('liveness=unverifiable provider=claude/opus')
    expect(output).not.toContain('heartbeat=')
  })
})
