import type {
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage
} from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeControlSurface } from './claude-agent-sdk-control-requests'
import { claudePlanApprovalMode, leaveClaudePlanModeOnApproval } from './claude-plan-approval-mode'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'
import {
  USER_MESSAGE,
  acquired,
  claudeFrame,
  fakeClaude
} from './claude-structured-session-test-support'

const PLAN_PROMPT: Pick<ClaudePendingPrompt, 'toolName'> = { toolName: 'ExitPlanMode' }
const ALLOW: PermissionResult = { behavior: 'allow', updatedInput: {}, toolUseID: 'tool-plan' }

type PlanSession = Parameters<typeof leaveClaudePlanModeOnApproval>[0]

function planSession(
  setPermissionMode: (mode: string) => Promise<void>,
  overrides: Partial<PlanSession> = {}
): PlanSession {
  return {
    connection: { setPermissionMode },
    reportedOptions: { reportedPermissionMode: 'plan' },
    launchIntent: { permissionMode: 'acceptEdits' },
    ...overrides
  }
}

function recordingQuery(setPermissionMode: Query['setPermissionMode']): Query {
  function unusedControl(): never {
    throw new Error('unexpected query control')
  }
  const messages = (async function* (): AsyncGenerator<SDKMessage, void> {
    yield* []
  })()
  return Object.assign(messages, {
    setPermissionMode,
    interrupt: unusedControl,
    setMcpPermissionModeOverride: unusedControl,
    setModel: unusedControl,
    setMaxThinkingTokens: unusedControl,
    applyFlagSettings: unusedControl,
    updateSettings: unusedControl,
    initializationResult: unusedControl,
    reinitialize: unusedControl,
    supportedCommands: unusedControl,
    supportedModels: unusedControl,
    supportedAgents: unusedControl,
    mcpServerStatus: unusedControl,
    getContextUsage: unusedControl,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: unusedControl,
    readFile: unusedControl,
    reloadPlugins: unusedControl,
    reloadSkills: unusedControl,
    reloadOutputStyles: unusedControl,
    accountInfo: unusedControl,
    rewindFiles: unusedControl,
    seedReadState: unusedControl,
    reconnectMcpServer: unusedControl,
    toggleMcpServer: unusedControl,
    readMcpResource: unusedControl,
    setMcpServers: unusedControl,
    streamInput: unusedControl,
    stopTask: unusedControl,
    backgroundTasks: unusedControl,
    close: unusedControl
  })
}

async function pendingPlanApproval(input: Record<string, unknown>, initPermissionMode?: string) {
  const claude = fakeClaude({ replayUuid: 'turn-1', initPermissionMode })
  const adapter = await acquired(claude)
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'client-turn-1',
    body: USER_MESSAGE,
    fence: 7
  })
  const connection = claude.connections[0]
  if (!connection) {
    throw new Error('expected Claude connection')
  }
  claudeFrame(connection, { type: 'system', subtype: 'status', permissionMode: 'plan' })
  const request = new AbortController()
  const answered = invokeCanUseTool(connection, 'ExitPlanMode', 'permission-plan', 'tool-plan', {
    input,
    signal: request.signal
  })
  adapter.bindPromptItemId('session-1', 'journal-plan', 'permission-plan')
  return { adapter, connection, answered, request }
}

describe('leaving Claude plan mode on an approved plan', () => {
  it.each<[Parameters<typeof claudePlanApprovalMode>[0], PermissionMode]>([
    [{ launchIntent: { permissionMode: 'acceptEdits' } }, 'acceptEdits'],
    [{ launchIntent: { permissionMode: 'bypassPermissions' } }, 'bypassPermissions'],
    [{ launchIntent: {}, firstRootInit: { permissionMode: 'auto' } }, 'auto'],
    [{ launchIntent: {}, firstRootInit: { permissionMode: 'dontAsk' } }, 'dontAsk'],
    [{ launchIntent: {}, firstRootInit: { permissionMode: 'unknown' } }, 'default'],
    // The user's own CLI settings started in plan: approving still lets Claude edit, asking each time.
    [{ launchIntent: {}, firstRootInit: { permissionMode: 'plan' } }, 'default'],
    [{}, 'default']
  ])('returns to the chat’s own mode (%j)', (session, mode) => {
    expect(claudePlanApprovalMode(session)).toBe(mode)
  })

  it('changes nothing for Keep planning, other approvals, or a chat already out of plan', () => {
    const setPermissionMode = vi.fn(async () => {})
    const deny: PermissionResult = { behavior: 'deny', message: 'keep planning', toolUseID: 't' }
    leaveClaudePlanModeOnApproval(planSession(setPermissionMode), PLAN_PROMPT, deny)
    leaveClaudePlanModeOnApproval(planSession(setPermissionMode), { toolName: 'Bash' }, ALLOW)
    leaveClaudePlanModeOnApproval(
      planSession(setPermissionMode, { reportedOptions: { reportedPermissionMode: 'ask' } }),
      PLAN_PROMPT,
      ALLOW
    )
    expect(setPermissionMode).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'plan text', input: { plan: '# Add multiply' }, mode: 'default', failure: 'none' },
    { label: 'empty input', input: {}, mode: 'default', failure: 'none' },
    { label: 'own dontAsk', input: {}, mode: 'dontAsk', failure: 'none' },
    { label: 'rejected mode request', input: {}, mode: 'default', failure: 'async' },
    { label: 'closed connection', input: {}, mode: 'default', failure: 'sync' }
  ])(
    'settles the real plan callback after its mode request: $label',
    async ({ input, mode, failure }) => {
      const { adapter, connection, answered } = await pendingPlanApproval(input, mode)
      const order: string[] = []
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const controls = createClaudeControlSurface(
        recordingQuery(async (requestedMode) => {
          order.push(`set_permission_mode:${requestedMode}`)
          if (failure === 'async') {
            throw new Error('mode rejected')
          }
        })
      )
      const setMode = vi.spyOn(connection, 'setPermissionMode').mockImplementation(
        failure === 'sync'
          ? (requestedMode) => {
              order.push(`set_permission_mode:${requestedMode}`)
              throw new Error('closed')
            }
          : controls.setPermissionMode
      )
      const callback = answered.promise.then((result) => {
        order.push('control_response')
        return result
      })
      try {
        await adapter.answerPrompt({
          sessionId: 'session-1',
          itemId: 'journal-plan',
          kind: 'approval',
          response: { kind: 'option', optionId: 'allow' },
          fence: 7,
          commit: async () => {
            expect(setMode).not.toHaveBeenCalled()
            expect(answered.settled()).toBe(false)
          }
        })

        await expect(callback).resolves.toMatchObject({
          behavior: 'allow',
          updatedInput: input,
          toolUseID: 'tool-plan'
        })
        expect(order).toEqual([`set_permission_mode:${mode}`, 'control_response'])
        expect(setMode).toHaveBeenCalledOnce()
        if (failure !== 'none') {
          await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
        }
      } finally {
        warn.mockRestore()
        setMode.mockRestore()
      }
    }
  )

  it.each(['failed commit', 'lost ownership'])(
    'does not change mode when approval has %s',
    async (failure) => {
      const { adapter, connection, answered, request } = await pendingPlanApproval({})
      const setMode = vi.spyOn(connection, 'setPermissionMode')
      await expect(
        adapter.answerPrompt({
          sessionId: 'session-1',
          itemId: 'journal-plan',
          kind: 'approval',
          response: { kind: 'option', optionId: 'allow' },
          fence: 7,
          commit: async () => {
            expect(setMode).not.toHaveBeenCalled()
            expect(answered.settled()).toBe(false)
            if (failure === 'failed commit') {
              throw new Error('journal write failed')
            }
            request.abort()
          }
        })
      ).rejects.toThrow()
      expect(setMode).not.toHaveBeenCalled()
      if (failure === 'lost ownership') {
        await expect(answered.promise).resolves.toBeNull()
      } else {
        expect(answered.settled()).toBe(false)
        // The failed write released its claim, so a later approval still works.
        await adapter.answerPrompt({
          sessionId: 'session-1',
          itemId: 'journal-plan',
          kind: 'approval',
          response: { kind: 'option', optionId: 'allow' },
          fence: 7,
          commit: async () => {}
        })
        await expect(answered.promise).resolves.toMatchObject({ behavior: 'allow' })
        expect(setMode).toHaveBeenCalledOnce()
      }
      setMode.mockRestore()
    }
  )
})
