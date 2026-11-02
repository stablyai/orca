import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { RuntimeClient } from '../../runtime-client'
import { okFixture } from '../../test-fixtures'

const client = new RuntimeClient('/tmp/orca-worker-start-pending', 60_000, null, null)
const PENDING = {
  operationId: 'op_1',
  fingerprint: 'fp_1',
  daemonGeneration: 'daemon_1',
  reservationGeneration: 'reservation_1'
}

// The host's answer when the caller's deadline passes while accepted Setup or launch still runs.
function pendingReceipt(pending: Record<string, string>) {
  return {
    runId: 'run_1',
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    state: 'outcome_unknown',
    stage: 'worktree_created',
    pending,
    effects: [{ kind: 'worktree', action: 'created', id: 'repo::/tmp/wt' }],
    residualResources: [{ kind: 'worktree', id: 'repo::/tmp/wt' }]
  }
}

describe('worker-start whose caller timed out while Setup still runs', () => {
  const output = { log: [] as unknown[], error: [] as unknown[] }

  beforeEach(() => {
    output.log.length = 0
    output.error.length = 0
    process.exitCode = undefined
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
    vi.spyOn(console, 'log').mockImplementation((line) => void output.log.push(line))
    vi.spyOn(console, 'error').mockImplementation((line) => void output.error.push(line))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  async function start(receipt: unknown): Promise<string[]> {
    const calls: string[] = []
    vi.spyOn(client, 'call').mockImplementation(async (method: string) => {
      calls.push(method)
      return okFixture('req_start', receipt)
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['worktree', 'new-top-level'],
        ['timeout-ms', '20000']
      ]),
      client,
      cwd: '/tmp/coord',
      json: true
    })
    return calls
  }

  it('reports the accepted pending launch, not a failure, and says not to resend', async () => {
    const calls = await start(pendingReceipt(PENDING))

    const printed = JSON.parse(String(output.log[0]))
    expect(printed.ok).toBe(true)
    expect(printed.result).toMatchObject({ state: 'outcome_unknown', pending: PENDING })
    expect(printed.result.next).toContain("Don't resend")
    expect(printed.result.next).toContain('orchestration worker-show --dispatch ctx_1')
    expect(printed.result.residualResources).toBeUndefined()
    expect(String(output.error[0])).toContain('start_pending')
    expect(process.exitCode).toBe(0)
    // No terminal exists yet; the host's continuation keeps a new workspace's worker open.
    expect(calls).not.toContain('orchestration.workerRetain')
  })

  it('keeps an incomplete pending identity an unknown outcome', async () => {
    const { reservationGeneration: _dropped, ...partial } = PENDING
    await start(pendingReceipt(partial))

    expect(JSON.parse(String(output.log[0])).ok).toBe(false)
    expect(String(output.error[0])).toContain('start_outcome_unknown')
    expect(process.exitCode).toBe(1)
  })
})
