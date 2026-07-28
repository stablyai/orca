import { describe, expect, it, vi } from 'vitest'
import { buildAgentStatusIpcPayload } from './agent-status-ipc-boundary'

describe('agent status IPC boundary', () => {
  it('preserves live hook identity and adds launch-token-verified reviewer attribution', () => {
    const getAgentStatusLaunchConfigForPaneKey = vi.fn(() => ({
      agentArgs: `-c 'approvals_reviewer="auto_review"'`,
      agentEnv: {}
    }))
    const result = buildAgentStatusIpcPayload(
      {
        paneKey: 'tab-1:leaf-1',
        launchToken: 'launch-1',
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        hookEventName: 'PermissionRequest',
        providerSession: { key: 'session_id', id: 'session-1' },
        payload: {
          state: 'waiting',
          prompt: 'run build',
          agentType: 'codex',
          toolName: 'exec_command'
        },
        receivedAt: 100,
        stateStartedAt: 90
      },
      {
        getAgentStatusTerminalHandleForPaneKey: () => 'terminal-1',
        getAgentStatusOrchestrationContextForPaneKey: () => undefined,
        getAgentStatusLaunchConfigForPaneKey
      }
    )

    expect(getAgentStatusLaunchConfigForPaneKey).toHaveBeenCalledWith('tab-1:leaf-1', {
      launchToken: 'launch-1'
    })
    expect(result).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      launchToken: 'launch-1',
      hookEventName: 'PermissionRequest',
      codexApprovalReviewer: 'auto_review',
      terminalHandle: 'terminal-1',
      state: 'waiting',
      agentType: 'codex'
    })
  })

  it('fails open when the runtime cannot verify the launch config', () => {
    const result = buildAgentStatusIpcPayload(
      {
        paneKey: 'tab-1:leaf-1',
        launchToken: 'launch-1',
        tabId: 'tab-1',
        connectionId: null,
        hookEventName: 'PermissionRequest',
        payload: {
          state: 'waiting',
          prompt: 'run build',
          agentType: 'codex',
          toolName: 'exec_command'
        },
        receivedAt: 100,
        stateStartedAt: 90
      },
      {
        getAgentStatusTerminalHandleForPaneKey: () => undefined,
        getAgentStatusOrchestrationContextForPaneKey: () => undefined
      }
    )

    expect(result.hookEventName).toBe('PermissionRequest')
    expect(result.codexApprovalReviewer).toBeUndefined()
  })

  it('preserves hook-stamped reviewer ownership after runtime launch metadata is gone', () => {
    const getAgentStatusLaunchConfigForPaneKey = vi.fn()
    const result = buildAgentStatusIpcPayload(
      {
        paneKey: 'tab-1:leaf-1',
        launchToken: 'launch-1',
        codexApprovalReviewer: 'auto_review',
        connectionId: null,
        hookEventName: 'PermissionRequest',
        payload: {
          state: 'waiting',
          prompt: 'run build',
          agentType: 'codex',
          toolName: 'exec_command'
        },
        receivedAt: 100,
        stateStartedAt: 90
      },
      {
        getAgentStatusTerminalHandleForPaneKey: () => undefined,
        getAgentStatusOrchestrationContextForPaneKey: () => undefined,
        getAgentStatusLaunchConfigForPaneKey
      }
    )

    expect(result.codexApprovalReviewer).toBe('auto_review')
    expect(getAgentStatusLaunchConfigForPaneKey).not.toHaveBeenCalled()
  })

  it('preserves explicit user review and skips reviewer lookup for other agents', () => {
    const getAgentStatusLaunchConfigForPaneKey = vi.fn(() => ({
      agentArgs: `-c 'approvals_reviewer="user"'`,
      agentEnv: {}
    }))
    const runtime = {
      getAgentStatusTerminalHandleForPaneKey: () => undefined,
      getAgentStatusOrchestrationContextForPaneKey: () => undefined,
      getAgentStatusLaunchConfigForPaneKey
    }
    const codex = buildAgentStatusIpcPayload(
      {
        paneKey: 'tab-1:leaf-1',
        launchToken: 'launch-1',
        connectionId: null,
        hookEventName: 'PermissionRequest',
        payload: { state: 'waiting', prompt: '', agentType: 'codex' },
        receivedAt: 100,
        stateStartedAt: 90
      },
      runtime
    )
    expect(codex.codexApprovalReviewer).toBe('user')

    getAgentStatusLaunchConfigForPaneKey.mockClear()
    const claude = buildAgentStatusIpcPayload(
      {
        paneKey: 'tab-2:leaf-2',
        connectionId: null,
        hookEventName: 'PermissionRequest',
        payload: { state: 'waiting', prompt: '', agentType: 'claude' },
        receivedAt: 110,
        stateStartedAt: 100
      },
      runtime
    )
    expect(claude.codexApprovalReviewer).toBeUndefined()
    expect(getAgentStatusLaunchConfigForPaneKey).not.toHaveBeenCalled()
  })
})
