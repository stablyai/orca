import { describe, expect, it, vi } from 'vitest'
import { setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { acquired, fakeClaude, PROVIDER_SESSION_ID } from './claude-structured-session-test-support'

function sessionFor(setModel: ClaudeSession['connection']['setModel']): ClaudeSession {
  return {
    connection: { setModel } as ClaudeSession['connection'],
    providerSessionId: 'provider-session',
    claudeConfigDir: '/accounts/claude',
    leafUuid: null,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    prompts: {} as ClaudeSession['prompts'],
    dispatchWaiters: [],
    retiredDispatchWaiters: [],
    replayContentFallbackBlocked: false,
    backgroundTasks: new ClaudeBackgroundTaskTracker(),
    dispatchSequence: 0,
    optionMutationSequence: 0,
    options: new Map(),
    reportedOptions: {},
    reportedModelMutation: 0,
    confirmedOptions: new Set(),
    restoreSkippedOptions: new Set(),
    capabilities: [],
    events: undefined,
    translator: null
  }
}

describe('Claude structured option mutation fencing', () => {
  it('exposes the same provider options and command availability to Rooms and native chat', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    claude.connections[0]!.handlers.onMessage?.({
      type: 'system',
      subtype: 'commands_changed',
      session_id: PROVIDER_SESSION_ID,
      commands: [{ name: 'compact', description: 'Compact context', argumentHint: 'instructions' }]
    })
    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result).toMatchObject({
      canCompact: true,
      canSteer: true,
      descriptors: expect.arrayContaining([
        expect.objectContaining({ id: 'model', transport: 'agent-session', settable: true })
      ])
    })
    expect(adapter.readConfiguration('session-1')).toMatchObject({
      options: result.descriptors,
      commands: [{ name: 'compact', description: 'Compact context', inputHint: 'instructions' }]
    })
    claude.connections[0]!.handlers.onMessage?.({
      type: 'system',
      subtype: 'commands_changed',
      session_id: PROVIDER_SESSION_ID,
      commands: []
    })
    expect(adapter.readConfiguration('session-1')?.canCompact).toBe(false)
    await adapter.closeAll()
  })

  it('does not let a delayed earlier apply overwrite a later option', async () => {
    let releaseFirst!: () => void
    const firstApply = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const setModel = vi
      .fn<ClaudeSession['connection']['setModel']>()
      .mockReturnValueOnce(firstApply)
      .mockResolvedValue(undefined)
    const session = sessionFor(setModel)

    const first = setClaudeStructuredOption(session, { key: 'model', value: 'old' }, undefined)
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1))
    const second = setClaudeStructuredOption(session, { key: 'model', value: 'new' }, undefined)
    await expect(second).resolves.toEqual({ model: 'new' })

    releaseFirst()
    await expect(first).resolves.toEqual({ model: 'new' })
    expect(session.options).toEqual(new Map([['model', 'new']]))
  })
})
