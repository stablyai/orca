import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'

const sent = vi.hoisted((): { preambles: string[] } => ({ preambles: [] }))
vi.mock('../../orchestration-structured-worker-session', () => ({
  sendStructuredWorkerPreamble: async (args: { preamble: string }) => {
    sent.preambles.push(args.preamble)
  }
}))

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

function runtime(prompts: string[]): OrcaRuntimeService {
  const fake: Pick<
    OrcaRuntimeService,
    'getNestedWorkerMaxDepth' | 'getTerminalOrchestrationCliCommand' | 'sendTerminalAgentPrompt'
  > = {
    getNestedWorkerMaxDepth: () => 0,
    getTerminalOrchestrationCliCommand: () => 'orca',
    sendTerminalAgentPrompt: async (handle, text) => {
      prompts.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliverWorkerDispatchPreamble reads only the three members the fake implements.
  return fake as OrcaRuntimeService
}

type StructuredSession = Parameters<typeof deliverWorkerDispatchPreamble>[0]['structuredSession']

function structuredSession(agent: 'claude' | 'codex' = 'claude'): StructuredSession {
  const session = { host: {}, identity: { sessionId: SESSION, agent } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery reads only identity.sessionId/agent, and the mocked send ignores host.
  return session as unknown as StructuredSession
}

const args = {
  db: new OrchestrationDb(':memory:'),
  dispatchId: 'ctx_1',
  dispatchDepth: 1,
  taskId: 'task_1',
  taskSpec: 'do it',
  coordinatorHandle: 'session:7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64',
  dispatchCapability: 'cap',
  devMode: false,
  requestId: 'req_1'
}

describe('deliverWorkerDispatchPreamble tells each worker its own address', () => {
  beforeEach(() => {
    sent.preambles = []
  })

  afterAll(() => {
    args.db.close()
  })

  it('names a structured worker by the session it was started as', async () => {
    const prompts: string[] = []
    await deliverWorkerDispatchPreamble({
      ...args,
      runtime: runtime(prompts),
      terminalHandle: 'structworker_1',
      structuredSession: structuredSession()
    })

    expect(prompts).toEqual([])
    expect(sent.preambles).toHaveLength(1)
    expect(sent.preambles[0]).toContain(`Your orchestration address is: session:${SESSION}\n`)
    expect(sent.preambles[0]).toContain(`orca orchestration send --from session:${SESSION}`)
    expect(sent.preambles[0]).not.toContain('structworker_1')
  })

  it('teaches a structured worker and a terminal worker the same text but for the address', async () => {
    const prompts: string[] = []
    await deliverWorkerDispatchPreamble({
      ...args,
      runtime: runtime(prompts),
      terminalHandle: 'structworker_1',
      structuredSession: structuredSession('codex')
    })
    await deliverWorkerDispatchPreamble({
      ...args,
      runtime: runtime(prompts),
      terminalHandle: 'term_worker',
      structuredSession: null
    })

    expect(sent.preambles[0]!.split(`session:${SESSION}`).join('<self>')).toBe(
      prompts[0]!.split('term_worker').join('<self>')
    )
  })

  it('names a terminal worker by its handle and keeps its bare CLI', async () => {
    const prompts: string[] = []
    await deliverWorkerDispatchPreamble({
      ...args,
      runtime: runtime(prompts),
      terminalHandle: 'term_worker',
      structuredSession: null
    })

    expect(sent.preambles).toEqual([])
    expect(prompts[0]).toContain('Your orchestration address is: term_worker\n')
    expect(prompts[0]).toContain('orca orchestration send --from term_worker')
  })
})
