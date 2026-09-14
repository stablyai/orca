import { describe, expect, it, vi } from 'vitest'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import {
  buildClaudePermissionCallbacks,
  CLAUDE_BLOCKING_CONTROL_CALLBACKS,
  CLAUDE_CAN_USE_TOOL_SUBTYPE,
  CLAUDE_REQUEST_USER_DIALOG_SUBTYPE
} from './claude-structured-inbound-control'

type CanUseToolOptions = Parameters<CanUseTool>[2]

function permissionOptions(
  requestId: string,
  toolUseID: string,
  signal: AbortSignal,
  suggestions?: unknown[]
): CanUseToolOptions {
  return {
    requestId,
    toolUseID,
    signal,
    ...(suggestions ? { suggestions } : {})
  } as unknown as CanUseToolOptions
}

function callbacksFor() {
  const prompts = new ClaudePromptRegistry()
  const emit = vi.fn()
  const { canUseTool, onUserDialog } = buildClaudePermissionCallbacks({
    sessionId: 'session-1',
    prompts,
    emit
  })
  return { prompts, emit, canUseTool, onUserDialog }
}

describe('Claude permission callbacks', () => {
  it('registers a decodable can_use_tool as a durable prompt and settles it from the registry', async () => {
    const control = callbacksFor()
    const answered = control.canUseTool(
      'Bash',
      { command: 'git status' },
      permissionOptions('perm-1', 'tool-1', new AbortController().signal, [{ type: 'addRules' }])
    )

    expect(control.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'prompt',
        sessionId: 'session-1',
        prompt: expect.objectContaining({ promptKey: 'perm-1', toolName: 'Bash', kind: 'approval' })
      })
    )
    const found = control.prompts.find('perm-1')
    expect(found?.prompt.suggestions).toEqual([{ type: 'addRules' }])
    // The prompt's settle is the SDK callback's own resolve — answering resolves this promise.
    found?.prompt.settle({ behavior: 'allow', toolUseID: 'tool-1' })
    await expect(answered).resolves.toEqual({ behavior: 'allow', toolUseID: 'tool-1' })
  })

  it('denies a malformed permission request without registering a prompt', async () => {
    const control = callbacksFor()
    const answered = control.canUseTool(
      '',
      {},
      permissionOptions('perm-2', 'tool-2', new AbortController().signal)
    )

    await expect(answered).resolves.toEqual({
      behavior: 'deny',
      message: 'Orca could not decode this permission request.',
      toolUseID: 'tool-2'
    })
    expect(control.prompts.find('perm-2')).toBeNull()
    expect(control.emit).not.toHaveBeenCalled()
  })

  it('settles a pending prompt with null and forgets it when the abort signal fires', async () => {
    const control = callbacksFor()
    const controller = new AbortController()
    const answered = control.canUseTool(
      'Bash',
      { command: 'ls' },
      permissionOptions('perm-3', 'tool-3', controller.signal)
    )
    expect(control.prompts.find('perm-3')).not.toBeNull()

    controller.abort()

    await expect(answered).resolves.toBeNull()
    expect(control.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'prompt-cancelled', promptKey: 'perm-3' })
    )
    // Forgotten: a late answer can no longer find the prompt to authorize the wrong tool.
    expect(control.prompts.find('perm-3')).toBeNull()
  })

  it('cancels a request whose abort raced ahead of delivery without emitting a prompt', async () => {
    const control = callbacksFor()
    const controller = new AbortController()
    controller.abort()

    const answered = control.canUseTool(
      'Bash',
      { command: 'ls' },
      permissionOptions('perm-4', 'tool-4', controller.signal)
    )

    await expect(answered).resolves.toBeNull()
    expect(control.prompts.find('perm-4')).toBeNull()
    expect(control.emit).toHaveBeenCalledTimes(1)
    expect(control.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'prompt-cancelled', promptKey: 'perm-4' })
    )
  })

  it('settles every in-flight prompt with null when the registry is cleared', async () => {
    const control = callbacksFor()
    const first = control.canUseTool(
      'Bash',
      { command: 'a' },
      permissionOptions('perm-5', 'tool-5', new AbortController().signal)
    )
    const second = control.canUseTool(
      'Bash',
      { command: 'b' },
      permissionOptions('perm-6', 'tool-6', new AbortController().signal)
    )

    // What session close does: settle each pending callback so no promise dangles.
    for (const prompt of control.prompts.clear()) {
      prompt.settle(null)
    }

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
  })

  it('answers a user dialog deny-safe', async () => {
    const control = callbacksFor()
    await expect(
      control.onUserDialog(
        { dialogKind: 'refusal_fallback_prompt', payload: {} },
        { signal: new AbortController().signal, requestId: 'dialog-1' }
      )
    ).resolves.toEqual({ behavior: 'cancelled' })
  })

  it('enumerates every blocking control request and wires a callback for each', () => {
    // The stable surface of controls a turn can block on. Adding one here without wiring its
    // callback below fails this test rather than silently leaving a control unhandled.
    expect(new Set(Object.keys(CLAUDE_BLOCKING_CONTROL_CALLBACKS))).toEqual(
      new Set([CLAUDE_CAN_USE_TOOL_SUBTYPE, CLAUDE_REQUEST_USER_DIALOG_SUBTYPE])
    )
    const callbacks = buildClaudePermissionCallbacks({
      sessionId: 'session-1',
      prompts: new ClaudePromptRegistry(),
      emit: vi.fn()
    }) as unknown as Record<string, unknown>
    for (const callbackName of Object.values(CLAUDE_BLOCKING_CONTROL_CALLBACKS)) {
      expect(typeof callbacks[callbackName], `${callbackName} must be wired`).toBe('function')
    }
  })
})
