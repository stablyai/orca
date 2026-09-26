import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'

const CHAT = 'session:3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26'

/** A chat worker's row, as a current host publishes it: its address where a terminal handle goes. */
const chatRow = {
  dispatchId: 'ctx_chat',
  taskId: 'task_chat',
  runId: 'run_1',
  workerState: 'ready',
  dispatchStatus: 'dispatched',
  agentTerminalHandle: CHAT,
  terminalState: 'retained',
  resource: { terminalHandle: CHAT, paneKey: null, ownershipState: 'external' },
  projection: {
    provider: null,
    host: { id: 'local' },
    workspace: { id: 'repo::/wt' },
    stage: { activity: 'unknown' },
    liveness: { verdict: 'live', source: 'execution_host' },
    nextAction: { argv: [] },
    attention: { categories: [] }
  }
}

describe('worker-list decodes a chat worker row like any other', () => {
  let logged: string[]

  beforeEach(() => {
    logged = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([false, true])('with --json %s', async (json) => {
    const client = {
      call: async (name: string) =>
        name === 'orchestration.workerList'
          ? {
              result: {
                workers: [chatRow],
                counts: { retained: 1 },
                page: { hasMore: false, nextCursor: null, total: 1 }
              }
            }
          : { result: { run: null } }
    }

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map([['run', 'run_1']]),
      client,
      cwd: '/tmp/repo',
      json
    } as never)

    const output = logged.join('\n')
    if (json) {
      expect(JSON.parse(output).result.workers[0]).toMatchObject({ agentTerminalHandle: CHAT })
    } else {
      expect(output).toContain(
        'ctx_chat task=task_chat [ready/unknown] attention=none liveness=live provider=unknown host=local workspace=repo::/wt terminal=retained next=none'
      )
    }
  })
})
