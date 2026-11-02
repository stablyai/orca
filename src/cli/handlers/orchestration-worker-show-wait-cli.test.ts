import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', async (importOriginal) => {
  const original = await importOriginal<{ printResult: typeof printResult }>()
  return { printResult: vi.fn(original.printResult) }
})
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { okFixture } from '../test-fixtures'
import { orchestrationTestContext } from './orchestration-handler-test-context'

async function showWorker(observation: unknown): Promise<string> {
  const result = {
    dispatch: { id: 'ctx_1', taskId: 'task_1', status: 'dispatched' },
    worker: { state: 'ready', stage: 'dispatch_input', agentTerminalHandle: 'term_1' },
    ...(observation === undefined ? {} : { observation })
  }
  callMock.mockResolvedValue(okFixture('req_show', result))
  await ORCHESTRATION_HANDLERS['orchestration worker-show'](
    orchestrationTestContext(
      callMock,
      new Map<string, string | boolean>([
        ['full', true],
        ['dispatch', 'ctx_1']
      ]),
      false
    )
  )
  expect(callMock).toHaveBeenCalledExactlyOnceWith('orchestration.workerShow', {
    dispatch: 'ctx_1'
  })
  expect(console.log).toHaveBeenCalledOnce()
  const output = vi.mocked(console.log).mock.calls[0]?.[0]
  if (typeof output !== 'string') {
    throw new Error('worker-show did not print text')
  }
  return output
}

describe('orchestration worker-show interactive wait output', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the prompt when a worker is waiting on a human', async () => {
    const line = await showWorker({
      status: 'live',
      exactWorker: true,
      agentWait: { source: 'prompt-text', reason: 'agent-approval-prompt', since: 1 }
    })

    expect(line).toContain('Waiting on a human: agent-approval-prompt (via prompt-text)')
  })

  it('says none when the pane was evaluated and nothing was waiting', async () => {
    const line = await showWorker({ status: 'live', exactWorker: true, agentWait: null })

    expect(line).toContain('Interactive wait: none')
  })

  it('says unknown when the field is absent, not none', async () => {
    const line = await showWorker({ status: 'identity_changed', exactWorker: false })

    expect(line).toContain('Interactive wait: unknown (not evaluated)')
    expect(line).not.toContain('Interactive wait: none')
  })

  it('says unknown when the host sent no observation at all', async () => {
    const line = await showWorker(undefined)

    expect(line).toContain('Interactive wait: unknown (not evaluated)')
  })
})
