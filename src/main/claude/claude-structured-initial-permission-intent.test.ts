import { expect, it, vi } from 'vitest'
import { withAgentChatPermissionSeed } from '../native-chat/agent-chat-permission-mode-setting'
import { record } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import { fakeClaude, USER_MESSAGE } from './claude-structured-session-test-support'

it.each(['accept-edits', 'auto'] as const)(
  'retains creation %s across Stop before initialize and a changed new-chat default',
  async (initialMode) => {
    const saved = {
      ...record({ chain: [] }),
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
      options: withAgentChatPermissionSeed(
        'claude',
        { nativeChatPermissionMode: initialMode },
        { model: 'sonnet' }
      )
    }
    expect(saved.options).toEqual({ model: 'sonnet', permissionMode: initialMode })
    const identity = {
      sessionId: saved.sessionId,
      workspaceId: saved.location.workspaceId,
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    }
    const resolveLaunch = createClaudeStructuredLaunchResolver({
      store: { getRecord: () => saved, pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async () => process.cwd(),
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveCommand: () => 'claude',
      resolveLaunchArgs: () => []
    })
    const claude = fakeClaude({ initProof: 'none' })
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch,
      openConnection: async (...args) => {
        const connection = await claude.openConnection(...args)
        connection.initializationResult = () => new Promise(() => {})
        return connection
      }
    })
    const acquire = { identity, fence: 1, spawnToken: 'first', options: saved.options }
    try {
      await adapter.acquire(acquire)
      const preparation = adapter.prepareDispatch(saved.sessionId)
      const aborted = Promise.resolve(preparation).catch(() => {})
      await adapter.closeSession(saved.sessionId)
      await aborted
      expect(claude.connections[0].closeCount).toBeGreaterThan(0)
      expect(claude.connections[0].sent).toEqual([])
      await adapter.acquire({ ...acquire, fence: 2, spawnToken: 'next' })
      const launch = claude.connections[1].launch
      expect(launch.options.extraArgs).not.toHaveProperty('dangerously-skip-permissions')
      expect(launch.options.permissionMode).toBe(
        initialMode === 'accept-edits' ? 'acceptEdits' : 'default'
      )
      expect(adapter['sessions'].get(saved.sessionId)?.options.get('permissionMode')).toBe(
        initialMode
      )
      expect(saved.options?.permissionMode).toBe(initialMode)
    } finally {
      await adapter.closeAll()
    }
  }
)

it.each(['saved', 'created'] as const)(
  'writes the first message under %s Accept edits while initialize is withheld',
  async (source) => {
    const options: Record<string, string> =
      source === 'saved'
        ? { model: 'sonnet', permissionMode: 'accept-edits' }
        : (withAgentChatPermissionSeed(
            'claude',
            { nativeChatPermissionMode: 'accept-edits' },
            { model: 'sonnet' }
          ) ?? {})
    const saved = {
      ...record({ chain: [] }),
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
      options
    }
    const resolveLaunch = createClaudeStructuredLaunchResolver({
      store: { getRecord: () => saved, pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async () => process.cwd(),
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveCommand: () => 'claude',
      resolveLaunchArgs: () => []
    })
    const claude = fakeClaude({ initProof: 'none' })
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch,
      openConnection: async (...args) => {
        const connection = await claude.openConnection(...args)
        connection.initializationResult = () => new Promise(() => {})
        return connection
      }
    })
    try {
      await adapter.acquire({
        identity: {
          sessionId: saved.sessionId,
          workspaceId: saved.location.workspaceId,
          hostId: 'local',
          agent: 'claude',
          providerHandle: null
        },
        fence: 1,
        spawnToken: 'first',
        options: saved.options
      })
      const session = adapter['sessions'].get(saved.sessionId)
      expect(claude.connections[0].launch.options.permissionMode).toBe('acceptEdits')
      expect(session?.appliedPermissionMode).toBe('accept-edits')
      expect(adapter.prepareDispatch(saved.sessionId)).toBeUndefined()
      await expect(
        adapter.dispatch({
          sessionId: saved.sessionId,
          clientMessageId: 'before-initialize',
          body: USER_MESSAGE,
          fence: 1
        })
      ).resolves.toEqual({ state: 'admitted' })
      expect(claude.connections[0].sent).toHaveLength(1)
      expect(session?.startup.state).toBe('pending')
      expect(session?.startup.answered).toBe(false)
      expect(claude.connections[0].calls).not.toContainEqual(
        expect.objectContaining({ subtype: 'set_permission_mode' })
      )
    } finally {
      await adapter.closeAll()
    }
  }
)
