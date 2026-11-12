import { describe, expect, it, vi } from 'vitest'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { ClaudePromptRegistry } from './permissions/claude-prompt-registry'
import { buildClaudePermissionCallbacks } from './claude-structured-inbound-control'

type CanUseToolOptions = Parameters<CanUseTool>[2]

function permissionOptions(
  requestId: string,
  toolUseID: string,
  signal: AbortSignal,
  suggestions?: CanUseToolOptions['suggestions'],
  presentation: Partial<CanUseToolOptions> = {}
): CanUseToolOptions {
  return {
    ...presentation,
    requestId,
    toolUseID,
    signal,
    ...(suggestions ? { suggestions } : {})
  }
}

function callbacksFor(fullAccess = false) {
  const prompts = new ClaudePromptRegistry()
  const emit = vi.fn()
  const { canUseTool, onUserDialog } = buildClaudePermissionCallbacks({
    sessionId: 'session-1',
    prompts,
    emit,
    fullAccessAt: () => fullAccess
  })
  return { prompts, emit, canUseTool, onUserDialog }
}

describe('Claude permission callbacks', () => {
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
})
