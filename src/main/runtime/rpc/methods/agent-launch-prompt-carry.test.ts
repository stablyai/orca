/** The runtime's typed-line carry report decides whether to paste: never duplicate a carried prompt or drop an uncarried one. */

import { describe, expect, it, vi } from 'vitest'
import { formatTerminalStartFailure } from '../../../../shared/terminal-start-failure'
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

describe('actual startup creation across internal launch projections', () => {
  it.each(
    (['existing', 'create-worktree'] as const).flatMap((target) =>
      (['fresh', 'reattach', 'adopted'] as const).map((context) => ({ target, context }))
    )
  )(
    'keeps $context diagnostic authority through $target prompt delivery',
    async ({ target, context }) => {
      const { runtime, sendTerminalAgentPrompt } = withPromptWriter(
        runtimeStub({ settings: {}, lineCarriesPrompt: false })
      )
      const handle = target === 'existing' ? 'term_1' : 'term_agent_first'
      const creation = {
        handle,
        ptyId: 'pty-created',
        incarnationId: 'inc-created',
        worktreeId: 'wt-new',
        title: null,
        ...(context === 'reattach' ? { isReattach: true as const } : {}),
        ...(context === 'adopted' ? { agentSessionDisposition: 'adopted' as const } : {})
      }
      runtime.createTerminal.mockResolvedValueOnce(creation)
      const original = runtime.createManagedWorktree.getMockImplementation()!
      runtime.createManagedWorktree.mockImplementation(async (args) => {
        if (typeof args.onStartupTerminalCreated === 'function') {
          args.onStartupTerminalCreated(creation)
        }
        return original(args)
      })
      const cause = {
        kind: 'exited' as const,
        exitCode: 256,
        initialOutputDiagnostic: 'git-bash-console-capacity' as const
      }
      Object.assign(runtime, {
        getPtyLivenessVerdict: () => ({ status: 'exited', incarnationId: 'inc-created', cause })
      })
      const exited = { satisfied: true, status: 'exited', exitCause: cause }
      runtime.waitForTerminal.mockResolvedValue(exited)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const receipt = await launch(
          {
            agent: 'claude',
            target:
              target === 'existing'
                ? { kind: target, worktree: 'id:wt-7' }
                : { kind: target, create: { repo: 'id:repo-1', name: 'task' } },
            prompt: SUBMIT
          },
          runtime
        )
        const error = warn.mock.calls.flat().find((item) => item instanceof Error)
        expect(formatTerminalStartFailure(error) !== undefined).toBe(context === 'fresh')
        expect(sendTerminalAgentPrompt.mock.calls.length).toBe(context === 'fresh' ? 0 : 1)
        expect(receipt).not.toHaveProperty('terminalCreation')
        expect(receipt).not.toHaveProperty('startupTerminalCreation')
      } finally {
        warn.mockRestore()
      }
    }
  )
})
