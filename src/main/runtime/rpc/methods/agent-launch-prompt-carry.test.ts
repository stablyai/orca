/**
 * `agent.launch` puts an argv agent's prompt on the command that starts it and never pastes it into
 * the running agent, however long or multi-line; only an agent that takes its text after start is
 * pasted into.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

const SUBMIT = { text: 'fix the failing checks\nlog tail follows', delivery: 'submit' }

function withPromptWriter(runtime: AgentLaunchRuntimeStub) {
  const waitForTerminal = vi.fn(async () => ({ satisfied: true, status: 'idle' }))
  // The idle evidence settles these launches; the composer signal never fires.
  const waitForFreshWorkerComposer = vi.fn(async () => {
    throw new Error('timeout')
  })
  const sendTerminalAgentPrompt = vi.fn(async () => ({
    handle: 'term_1',
    accepted: true,
    bytesWritten: 1
  }))
  return {
    runtime: Object.assign(runtime, {
      waitForTerminal,
      waitForFreshWorkerComposer,
      sendTerminalAgentPrompt
    }),
    sendTerminalAgentPrompt
  }
}

async function launch(params: unknown, runtime: AgentLaunchRuntimeStub) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, CAPABLE_CLIENT))
}

describe('a launch prompt reaches the agent on its command line', () => {
  const EXISTING = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
  const CREATE = { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }

  it('hands a multi-line prompt to the terminal create and never pastes it', async () => {
    const { runtime, sendTerminalAgentPrompt } = withPromptWriter(runtimeStub({ settings: {} }))

    const result = await launch({ ...EXISTING, prompt: SUBMIT }, runtime)

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(runtime.createTerminal.mock.calls[0]?.[1]).toMatchObject({ startupPrompt: SUBMIT.text })
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('hands it to an agent-first create’s startup terminal and never pastes it', async () => {
    const { runtime, sendTerminalAgentPrompt } = withPromptWriter(runtimeStub({ settings: {} }))

    const result = await launch({ agent: 'claude', target: CREATE, prompt: SUBMIT }, runtime)

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(runtime.createManagedWorktree.mock.calls[0]?.[0]).toMatchObject({
      startupPrompt: SUBMIT.text
    })
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('still pastes for an agent that takes its text only after start', async () => {
    const { runtime, sendTerminalAgentPrompt } = withPromptWriter(runtimeStub({ settings: {} }))

    const result = await launch({ ...EXISTING, agent: 'aider', prompt: SUBMIT }, runtime)

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(runtime.createTerminal.mock.calls[0]?.[1]?.startupPrompt).toBeUndefined()
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith('term_1', SUBMIT.text, expect.anything())
  })
})
