// `worker-show` text output must keep "nobody is waiting" apart from "nobody looked".
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

function renderedLine(result: unknown): string {
  const [value, , render] = vi.mocked(printResult).mock.calls[0] as [
    unknown,
    boolean,
    (value: unknown) => string
  ]
  expect(value).toBe(result)
  return render(value)
}

async function showWorker(observation: unknown): Promise<string> {
  const result = {
    dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' },
    worker: { state: 'ready', stage: 'dispatch_input', agent_terminal_handle: 'term_1' },
    ...(observation === undefined ? {} : { observation })
  }
  callMock.mockResolvedValue(result)
  await ORCHESTRATION_HANDLERS['orchestration worker-show']({
    flags: new Map<string, string | boolean>([['dispatch', 'ctx_1']]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
  return renderedLine(result)
}

describe('orchestration worker-show interactive wait output', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
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
    // An older host, or a worker whose identity could not be verified. Printing the same
    // thing as an evaluated `null` is the false negative this field exists to remove.
    const line = await showWorker({ status: 'identity_changed', exactWorker: false })

    expect(line).toContain('Interactive wait: unknown (not evaluated)')
    expect(line).not.toContain('Interactive wait: none')
  })

  it('says unknown when the host sent no observation at all', async () => {
    const line = await showWorker(undefined)

    expect(line).toContain('Interactive wait: unknown (not evaluated)')
  })
})
