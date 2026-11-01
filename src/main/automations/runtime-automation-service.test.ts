import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentLauncher from './automation-chat-agent-launch'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTerminalObserver } from './run-completion-watcher'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { automationRunOperationId } from './automation-run-operation'

type Options = {
  headlessDispatcher?: HeadlessAutomationDispatcher
  chatDispatcher?: HeadlessAutomationDispatcher
  terminalObserver?: AutomationRunTerminalObserver
}
const captured = vi.hoisted(() => {
  const options: Options = {}
  return {
    options,
    launch: vi.fn(),
    observeChat: vi.fn(),
    markDispatchResult: vi.fn()
  }
})
const { deliverTerminalAgentLaunchPrompt } = vi.hoisted(() => ({
  deliverTerminalAgentLaunchPrompt: vi.fn(async () => true)
}))
vi.mock('../runtime/rpc/methods/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt
}))

vi.mock('./service', () => ({
  AutomationService: class {
    start(): void {}
    stop(): void {}
    markDispatchResult = captured.markDispatchResult
    constructor(_store: unknown, opts: Options) {
      captured.options = opts
    }
  }
}))
vi.mock('./automation-chat-agent-launch', async (original) => ({
  ...(await original<typeof AgentLauncher>()),
  launchAutomationChatAgent: captured.launch
}))
vi.mock('./runtime-chat-run-observer', () => ({ observeAutomationChatRun: captured.observeChat }))
import { createRuntimeAutomationService } from './runtime-automation-service'
const state = buildProfileStateCutoverFixture('/fixture')
const run = {
  ...state.automationRuns[0],
  createdAt: 1_700_000_000_000,
  status: 'dispatching' as const,
  chatSessionId: null
}
function fixture(headless: boolean, definitionSurface: 'chat' | 'terminal' = 'chat') {
  const rows = new Map<string, unknown>()
  const records = {
    getOperationRow: (_caller: string, id: string) => rows.get(id),
    getConversation: () => ({
      sessionId: 'claude_chat',
      provider: 'claude',
      location: { workspaceId: 'wt-1' }
    })
  }
  const runtime = {
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    openAgentSessionRecordStore: async () => records,
    openedAgentSessionRecordStore: () => records,
    getTerminalHandleForPaneKey: vi.fn((_pane: string): string | null => null),
    getTerminalPtyIdForHandle: vi.fn((_handle: string): string | null => 'pty-1'),
    getTerminalPaneKey: vi.fn(
      () => '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    ),
    waitForTerminal: vi.fn(async () => ({ state: 'done' })),
    getAgentStatusRowsForPane: vi.fn(() => [])
  }
  createRuntimeAutomationService({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: construction and recovery use only these store boundaries.
    store: {
      listAutomationRuns: () => [],
      listAutomations: () => [
        { id: run.automationId, agentId: 'claude', surface: definitionSurface }
      ]
    } as unknown as Store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launching and chat observation are mocked; the runtime implements the recovery boundaries.
    runtime: runtime as unknown as OrcaRuntimeService,
    headless
  })
  return { runtime, rows }
}
beforeEach(() => {
  vi.clearAllMocks()
  captured.markDispatchResult.mockImplementation(async (result) => ({ ...run, ...result }))
  captured.observeChat.mockResolvedValue({ status: 'completed' })
})
describe('host-owned automation execution', () => {
  it.each([false, true])(
    'uses the same Chat dispatcher on desktop/headless=%s without supplying a desktop Terminal dispatcher',
    async (headless) => {
      fixture(headless)
      captured.launch.mockResolvedValue({
        workspaceId: 'wt-1',
        terminalSessionId: 'tab-1',
        terminalPaneKey:
          '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        terminalHandle: 'term-1'
      })
      expect(Boolean(captured.options.headlessDispatcher)).toBe(headless)
      const dispatcher = captured.options.chatDispatcher!
      const result = await dispatcher({
        automation: { ...state.automations[0], surface: 'chat' },
        run,
        target: { ok: true, cwd: '/fixture', repo: state.repos[0] }
      })
      expect(result.completion).toBeUndefined()
      expect(captured.launch).toHaveBeenCalledOnce()
      expect(
        captured.options.terminalObserver!.resolveRunTerminal({
          ...run,
          status: 'dispatched',
          terminalPaneKey:
            '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
        })
      ).toBe('term-1')
    }
  )
  it.each(['fresh-launch', 'reuse-send'] as const)(
    'recovers a %s accepted chat before the automation run identity was saved',
    async (purpose) => {
      const { rows } = fixture(false, purpose === 'fresh-launch' ? 'terminal' : 'chat')
      rows.set(automationRunOperationId(run, purpose), {
        outcome: {
          status: 'succeeded',
          sessionId: 'claude_chat',
          ...(purpose === 'fresh-launch'
            ? {
                launch: {
                  worktreeId: 'wt-1',
                  outcome: { kind: 'structured', sessionId: 'claude_chat', handle: 'chat-tab' },
                  receipt: {
                    mode: 'structured',
                    preferred: 'structured',
                    reason: 'requested',
                    detail: 'Chat'
                  },
                  prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'opening' }
                }
              }
            : {})
        }
      })
      const observer = captured.options.terminalObserver!
      const handle = observer.resolveRunTerminal(run)!
      expect(
        await observer.observeCompletion(handle, { run, signal: new AbortController().signal })
      ).toEqual({ status: 'completed' })
      expect(captured.markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKind: 'chat',
          chatSessionId: 'claude_chat',
          terminalPaneKey: null,
          terminalSessionId: null,
          terminalPtyId: null
        })
      )
      expect(captured.observeChat).toHaveBeenCalledOnce()
      expect(captured.launch).not.toHaveBeenCalled()
    }
  )
  it('recovers an accepted Chat request that actually fell back to Terminal without relaunch', async () => {
    const { rows, runtime } = fixture(false, 'terminal')
    rows.set(automationRunOperationId(run, 'fresh-launch'), {
      outcome: {
        status: 'succeeded',
        launch: {
          worktreeId: 'wt-1',
          outcome: {
            kind: 'terminal',
            handle: 'term-fallback',
            paneKey: 'tab:11111111-1111-4111-8111-111111111111'
          },
          receipt: {
            mode: 'terminal',
            preferred: 'structured',
            reason: 'unsupported',
            detail: 'Fallback'
          },
          prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
        }
      }
    })
    runtime.waitForTerminal.mockRejectedValueOnce(new Error('ordinary-terminal-observer'))
    const observer = captured.options.terminalObserver!
    await expect(
      observer.observeCompletion(observer.resolveRunTerminal(run)!, {
        run,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('ordinary-terminal-observer')
    expect(captured.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dispatched',
        sessionKind: 'terminal',
        terminalPtyId: 'pty-1'
      })
    )
    expect(runtime.waitForTerminal).toHaveBeenCalledWith('term-fallback', expect.anything())
    expect(captured.observeChat).not.toHaveBeenCalled()
    expect(captured.launch).not.toHaveBeenCalled()
  })
  it.each(['chat', 'terminal'] as const)(
    'recovers a published failed %s receipt without accepting or sending it',
    async (kind) => {
      const { rows, runtime } = fixture(false)
      rows.set(automationRunOperationId(run, 'fresh-launch'), {
        outcome: {
          status: 'succeeded',
          launch: {
            worktreeId: 'actually-published',
            outcome:
              kind === 'chat'
                ? { kind: 'structured', sessionId: 'claude_published', handle: 'chat-tab' }
                : {
                    kind: 'terminal',
                    handle: 'term-published',
                    paneKey: 'tab:11111111-1111-4111-8111-111111111111'
                  },
            receipt: {
              mode: kind === 'chat' ? 'structured' : 'terminal',
              preferred: 'structured',
              reason: 'requested',
              detail: 'Published'
            },
            prompt: { delivery: 'submit', outcome: 'unconfirmed' }
          }
        }
      })
      const observer = captured.options.terminalObserver!
      expect(
        await observer.observeCompletion(observer.resolveRunTerminal(run)!, {
          run,
          signal: new AbortController().signal
        })
      ).toMatchObject({ status: 'dispatch_failed' })
      expect(captured.markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'actually-published',
          status: 'dispatch_failed',
          sessionKind: kind,
          ...(kind === 'chat'
            ? { chatSessionId: 'claude_published', terminalPaneKey: null }
            : {
                terminalSessionId: 'tab',
                terminalPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
              })
        })
      )
      expect(runtime.waitForTerminal).not.toHaveBeenCalled()
      expect(captured.observeChat).not.toHaveBeenCalled()
      expect(captured.launch).not.toHaveBeenCalled()
    }
  )
  it('refuses an ambiguous crash without resending or marking success', async () => {
    const { rows } = fixture(false)
    rows.set(automationRunOperationId(run, 'fresh-launch'), { outcome: { status: 'unknown' } })
    const observer = captured.options.terminalObserver!
    expect(
      await observer.observeCompletion(observer.resolveRunTerminal(run)!, {
        run,
        signal: new AbortController().signal
      })
    ).toMatchObject({ status: 'dispatch_failed', error: expect.stringContaining('Claude') })
    expect(captured.launch).not.toHaveBeenCalled()
  })
})

function capturedOption<K extends keyof Options>(key: K): NonNullable<Options[K]> {
  const value = captured.options[key]
  if (value === undefined) {
    throw new Error(`the service was constructed without ${key}`)
  }
  return value
}

describe('headless automation dispatch', () => {
  it('hands the launched run to its watcher instead of awaiting one tui-idle wait itself', async () => {
    const repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
    const managedWorktree = { id: 'wt-1', displayName: 'repo', hostId: 'local' as const }
    const runtime = {
      setAutomationService: vi.fn(),
      notifyAutomationsChanged: vi.fn(),
      launchAgentTerminal: vi.fn(async () => ({
        handle: 'terminal-1',
        tabId: 'tab-1',
        paneKey: 'tab-1:pane-1',
        ptyId: 'pty-1',
        worktreeId: 'wt-1'
      })),
      resolveManagedTerminalWorkspaceTarget: vi.fn(async () => ({
        managedWorktree,
        scope: { folderWorkspace: null }
      })),
      waitForTerminal: vi.fn(),
      getTerminalHandleForPaneKey: vi.fn(() => null),
      getAgentStatusRowsForPane: vi.fn(() => [])
    }
    createRuntimeAutomationService({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service never reads the store; the dispatcher reads only past runs.
      store: { listAutomationRuns: () => [] } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the members faked above.
      runtime: runtime as never,
      headless: true
    })
    const dispatcher = capturedOption('headlessDispatcher')
    const launch = await dispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reuse-workspace automation; only these fields are read.
      automation: {
        workspaceMode: 'existing',
        workspaceId: 'wt-1',
        agentId: 'goose'
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the title and trigger are read.
      run: { title: 'Nightly', trigger: 'scheduled' } as never,
      target: { ok: true, cwd: '/repo', repo }
    })

    expect(launch.completion).toBeUndefined()
    expect(launch.terminalPaneKey).toBe('tab-1:pane-1')
    expect(runtime.resolveManagedTerminalWorkspaceTarget).toHaveBeenCalledWith(
      'id:wt-1',
      'local',
      false
    )
    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      {
        agent: 'goose',
        prompt: '',
        title: 'Nightly',
        suppressStartupUpdatePrompt: true
      },
      { worktree: managedWorktree, repo, folderWorkspace: undefined }
    )
    expect(runtime.waitForTerminal).not.toHaveBeenCalled()
    const observer = capturedOption('terminalObserver')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution reads only the pane key.
    expect(observer.resolveRunTerminal({ terminalPaneKey: 'tab-1:pane-1' } as never)).toBe(
      'terminal-1'
    )
  })
})
