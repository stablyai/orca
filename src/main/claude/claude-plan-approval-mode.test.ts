import { describe, expect, it, vi } from 'vitest'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  acquired,
  claudeFrame,
  fakeClaude,
  tick,
  type FakeConnection
} from './structured/claude-structured-session-test-support'
import { claudeStructuredPermissionOptions } from './structured/launch/claude-structured-launch-resolution'

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

  it('restores Full access from the plan Claude reported on the wire, before presentation reads it', async () => {
    // Init reported bypassPermissions through presentation; the later plan status is still unread there.
    const claude = fakeClaude({ replayUuid: 'turn-1', initPermissionMode: 'bypassPermissions' })
    const adapter = await acquired(claude, {
      options: claudeStructuredPermissionOptions('full-access')
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-turn-1',
      body: USER_MESSAGE,
      fence: 7
    })
    const connection = claude.connections[0]!
    const raw = (target: FakeConnection, frame: Record<string, unknown>): void =>
      target.handlers.onStdout?.(`${JSON.stringify(frame)}\n`)
    const request = (id: string, toolName: string, input: Record<string, unknown>) => {
      raw(connection, {
        type: 'control_request',
        request_id: id,
        request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: `tool-${id}` }
      })
      return invokeCanUseTool(connection, toolName, id, `tool-${id}`, { input })
    }
    const status = (permissionMode: string) => ({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode,
      session_id: PROVIDER_SESSION_ID
    })
    raw(connection, status('plan'))
    const plan = request('permission-plan', 'ExitPlanMode', { plan: '# Plan' })
    adapter.bindPromptItemId('session-1', 'journal-plan', 'permission-plan')
    const order: string[] = []
    const setMode = vi.spyOn(connection, 'setPermissionMode').mockImplementation((mode) => {
      order.push(`set_permission_mode:${mode}`)
      // Never resolves: the approval must not wait for Claude to confirm the mode.
      return new Promise(() => {})
    })
    const answered = plan.promise.then((result) => {
      order.push('control_response')
      return result
    })

    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'journal-plan',
      kind: 'approval',
      response: { kind: 'option', optionId: 'allow' },
      fence: 7,
      commit: async () => {}
    })
    await expect(answered).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-permission-plan'
    })
    expect(order).toEqual(['set_permission_mode:bypassPermissions', 'control_response'])
    expect(setMode).toHaveBeenCalledOnce()

    // Sending the restore grants nothing; Claude's own bypass report does.
    const beforeReport = request('before-report', 'Bash', { command: 'ls' })
    await tick()
    expect(beforeReport.settled()).toBe(false)
    raw(connection, status('bypassPermissions'))
    const afterReport = request('after-report', 'Bash', { command: 'ls' })
    await expect(afterReport.promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      toolUseID: 'tool-after-report'
    })
    setMode.mockRestore()
  })
})
