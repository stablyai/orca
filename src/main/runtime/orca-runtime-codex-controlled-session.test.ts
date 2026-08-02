import { describe, expect, it, vi } from 'vitest'
import type { CodexControlledSessionManager } from '../codex/codex-controlled-session-manager'
import { OrcaRuntimeService } from './orca-runtime'

describe('OrcaRuntimeService controlled Codex binding', () => {
  it('binds the visible controlled session to the exact Run generation', async () => {
    const manager = createManager()
    const runtime = new OrcaRuntimeService(null, undefined, {
      codexControlledSessionManager: manager as unknown as CodexControlledSessionManager
    })
    const bind = vi
      .spyOn(runtime, 'bindOrchestrationConversationWake')
      .mockResolvedValue({} as never)

    await expect(runtime.launchControlledCodexConversation(launch())).resolves.toMatchObject({
      identity: { threadId: 'thread-1' },
      disposition: 'created'
    })
    expect(bind).toHaveBeenCalledWith({
      runId: 'run-1',
      consumerGeneration: 7,
      provider: 'codex-controlled',
      conversationId: 'conversation-1'
    })
  })

  it('disposes the controller when Run binding fails', async () => {
    const manager = createManager()
    const runtime = new OrcaRuntimeService(null, undefined, {
      codexControlledSessionManager: manager as unknown as CodexControlledSessionManager
    })
    vi.spyOn(runtime, 'bindOrchestrationConversationWake').mockRejectedValue(new Error('fenced'))

    await expect(runtime.launchControlledCodexConversation(launch())).rejects.toThrow('fenced')
    expect(manager.disposeConversation).toHaveBeenCalledWith('conversation-1')
  })

  it('preserves the binding failure when controller cleanup also fails', async () => {
    const manager = createManager()
    manager.disposeConversation.mockRejectedValue(new Error('cleanup failed'))
    const runtime = new OrcaRuntimeService(null, undefined, {
      codexControlledSessionManager: manager as unknown as CodexControlledSessionManager
    })
    const bindingError = new Error('fenced')
    vi.spyOn(runtime, 'bindOrchestrationConversationWake').mockRejectedValue(bindingError)

    await expect(runtime.launchControlledCodexConversation(launch())).rejects.toBe(bindingError)
    expect(bindingError).toMatchObject({ cleanupError: expect.any(Error) })
  })

  it('preserves a reused valid controller when a stale Run binding fails', async () => {
    const manager = createManager('reused')
    const runtime = new OrcaRuntimeService(null, undefined, {
      codexControlledSessionManager: manager as unknown as CodexControlledSessionManager
    })
    vi.spyOn(runtime, 'bindOrchestrationConversationWake').mockRejectedValue(new Error('fenced'))

    await expect(runtime.launchControlledCodexConversation(launch())).rejects.toThrow('fenced')
    expect(manager.disposeConversation).not.toHaveBeenCalled()
  })
})

function createManager(disposition: 'created' | 'reused' = 'created') {
  return {
    id: 'codex-controlled',
    launch: vi.fn().mockResolvedValue({
      disposition,
      identity: {
        conversationId: 'conversation-1',
        threadId: 'thread-1',
        terminalHandle: 'handle-1',
        terminalPtyId: 'pty-1',
        terminalTabId: 'tab-1',
        terminalPaneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        worktreeId: 'worktree-1'
      }
    }),
    disposeConversation: vi.fn(),
    getState: vi.fn(),
    prepareAndFinalizeTurn: vi.fn(),
    onTurnTerminal: vi.fn(() => () => {}),
    dispose: vi.fn()
  }
}

function launch() {
  return {
    runId: 'run-1',
    consumerGeneration: 7,
    conversationId: 'conversation-1',
    threadId: 'thread-1',
    worktreeSelector: 'id:worktree-1',
    workspaceKind: 'worktree' as const,
    hostKind: 'local' as const,
    cwd: '/repo',
    codexHome: '/codex-home',
    accountId: 'account-1'
  }
}
