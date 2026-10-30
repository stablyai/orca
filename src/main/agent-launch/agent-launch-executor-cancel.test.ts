import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import { AgentLaunchStructuredSessionRefusedError } from './agent-launch-surface-factories'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'

const PROMPT = { text: 'fix the flaky test', delivery: 'submit' as const }

function harness(options: {
  structured?: boolean
  duringCreate?: () => void
  duringModeSettle?: () => void
  duringStructuredRefusal?: () => void
  lineCarriesPrompt?: boolean
  startupSpawnFails?: boolean
}) {
  const calls: string[] = []
  const carried = (startupPrompt: string | undefined) =>
    startupPrompt && options.lineCarriesPrompt ? { promptRodeLaunchCommand: true } : {}
  const createWorktree = vi.fn(
    async (args: {
      startupAgent: string | undefined
      startupPrompt?: string
      onWorkspaceCreated?: (worktreeId: string) => void
    }) => {
      calls.push('createWorktree')
      args.onWorkspaceCreated?.('wt-new')
      options.duringCreate?.()
      return {
        worktreeId: 'wt-new',
        workspacePath: '/repo/task',
        connectionId: null,
        startupTerminalHandle:
          args.startupAgent && !options.startupSpawnFails ? 'term_agent_first' : undefined,
        ...carried(args.startupPrompt)
      }
    }
  )
  const createRecoveryShell = vi.fn(async () => {
    calls.push('createRecoveryShell')
  })
  const getStructuredAgentSessionCreateSupport = vi.fn(async () => {
    calls.push('createSupport')
    options.duringModeSettle?.()
    return { supported: true }
  })
  const createStructuredSession = vi.fn(async () => {
    calls.push('createStructuredSession')
    if (options.duringStructuredRefusal) {
      options.duringStructuredRefusal()
      throw new AgentLaunchStructuredSessionRefusedError(
        'structured_agent_session_unsupported',
        'unsupported'
      )
    }
    return { sessionId: 'sess-1', handle: 'handle_structured', fence: 4 }
  })
  const createTerminalAgent = vi.fn(async (args: { startupPrompt?: string }) => {
    calls.push('createTerminalAgent')
    return { handle: 'term_1', ...carried(args.startupPrompt) }
  })
  const deliverTerminalPrompt = vi.fn(async (_args: { signal?: AbortSignal }) => {
    calls.push('deliverTerminalPrompt')
    return true
  })
  const runtime: AgentLaunchExecution['runtime'] = {
    requireStore: () => ({
      getSettings: () => (options.structured ? { experimentalNativeChat: true } : null)
    }),
    getStructuredAgentSessionCreateSupport
  }
  return {
    calls,
    createRecoveryShell,
    createTerminalAgent,
    deliverTerminalPrompt,
    run: (intent: AgentLaunchIntent, signal: AbortSignal) =>
      executeAgentLaunch({
        runtime,
        intent,
        surfaces: {
          createStructuredSession,
          createTerminalAgent,
          deliverTerminalPrompt
        },
        workspaces: { createWorktree, createRecoveryShell },
        signal
      })
  }
}

const CREATE: AgentLaunchIntent = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } },
  prompt: PROMPT
}

describe('agent launch cancellation', () => {
  it('starts nothing when already cancelled after the caller prepared it', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness({})

    await expect(h.run(CREATE, controller.signal)).rejects.toThrow('request_aborted')
    expect(h.calls).toEqual([])
  })

  it('creates no agent when cancelled during workspace creation', async () => {
    const controller = new AbortController()
    const h = harness({ structured: true, duringCreate: () => controller.abort() })

    await expect(h.run(CREATE, controller.signal)).rejects.toThrow('request_aborted')
    expect(h.calls).toEqual(['createWorktree', 'createRecoveryShell'])
  })

  it('recovers a terminal-mode workspace whose startup spawn failed when cancelled after it', async () => {
    const controller = new AbortController()
    const h = harness({ startupSpawnFails: true, duringCreate: () => controller.abort() })

    await expect(h.run(CREATE, controller.signal)).rejects.toThrow('request_aborted')
    expect(h.calls).toEqual(['createWorktree', 'createRecoveryShell'])
    expect(h.createTerminalAgent).not.toHaveBeenCalled()
  })

  it('creates no agent when cancelled while the host settles the mode', async () => {
    const controller = new AbortController()
    const h = harness({ structured: true, duringModeSettle: () => controller.abort() })

    await expect(
      h.run(
        { agent: 'claude', target: { kind: 'existing', worktree: 'wt-7' }, prompt: PROMPT },
        controller.signal
      )
    ).rejects.toThrow('request_aborted')
    expect(h.calls).toEqual(['createSupport'])
  })

  it.each([
    ['an existing workspace', { kind: 'existing', worktree: 'wt-7' }],
    ['a created workspace', CREATE.target]
  ] as const)(
    'starts no terminal fallback, argv prompt included, when cancelled during a structured refusal in %s',
    async (_label, target) => {
      const controller = new AbortController()
      const h = harness({
        structured: true,
        lineCarriesPrompt: true,
        duringStructuredRefusal: () => controller.abort()
      })

      await expect(
        h.run({ agent: 'claude', target, prompt: PROMPT }, controller.signal)
      ).rejects.toThrow('request_aborted')
      expect(h.createTerminalAgent).not.toHaveBeenCalled()
      expect(h.calls.includes('createRecoveryShell')).toBe(target.kind !== 'existing')
    }
  )

  it('returns an agent first started by the create, without pasting its prompt', async () => {
    const controller = new AbortController()
    const h = harness({ duringCreate: () => controller.abort(), lineCarriesPrompt: false })

    const result = await h.run(CREATE, controller.signal)

    expect(result.outcome).toMatchObject({ kind: 'terminal', handle: 'term_agent_first' })
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'not-delivered' })
    expect(h.deliverTerminalPrompt).not.toHaveBeenCalled()
  })

  it('keeps a prompt the launch command already carried as handed over', async () => {
    const controller = new AbortController()
    const h = harness({ duringCreate: () => controller.abort(), lineCarriesPrompt: true })

    const result = await h.run(CREATE, controller.signal)

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
  })

  it('hands its signal to the terminal prompt delivery', async () => {
    const controller = new AbortController()
    const h = harness({ lineCarriesPrompt: false })

    await h.run(CREATE, controller.signal)

    expect(h.deliverTerminalPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    )
  })
})
