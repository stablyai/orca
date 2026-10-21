/**
 * Whether `agent.launch` pastes an argv agent's prompt is the runtime's report about the line it
 * typed, not the executor's guess: a carried prompt must not be pasted a second time, and an
 * uncarried one must not be left undelivered.
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

describe('an argv agent’s launch prompt, by what the runtime reports about its typed line', () => {
  const EXISTING = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }

  it('pastes it once the agent is ready when the line could not carry it', async () => {
    const { runtime, sendTerminalAgentPrompt } = withPromptWriter(
      runtimeStub({ settings: {}, lineCarriesPrompt: false })
    )

    const result = await launch({ ...EXISTING, prompt: SUBMIT }, runtime)

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith('term_1', SUBMIT.text, expect.anything())
  })

  it('does not paste a prompt the line already carried', async () => {
    const { runtime, sendTerminalAgentPrompt } = withPromptWriter(
      runtimeStub({ settings: {}, lineCarriesPrompt: true })
    )

    const result = await launch({ ...EXISTING, prompt: SUBMIT }, runtime)

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('pastes into an agent-first create’s startup terminal when its line could not carry it', async () => {
    const { runtime, sendTerminalAgentPrompt } = withPromptWriter(
      runtimeStub({ settings: {}, lineCarriesPrompt: false })
    )

    const result = await launch(
      {
        agent: 'claude',
        target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } },
        prompt: SUBMIT
      },
      runtime
    )

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_agent_first',
      SUBMIT.text,
      expect.anything()
    )
  })

  it('does not paste into an agent-first create’s startup terminal whose line carried it', async () => {
    const { runtime, sendTerminalAgentPrompt } = withPromptWriter(
      runtimeStub({ settings: {}, lineCarriesPrompt: true })
    )

    await launch(
      {
        agent: 'claude',
        target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } },
        prompt: SUBMIT
      },
      runtime
    )

    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
