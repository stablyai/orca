import { describe, expect, it, vi } from 'vitest'
import { setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from '../claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from '../../claude-background-task-tracker'
import { ClaudeChildWorkDecoder } from '../../claude-child-work-decoder'
import { ClaudeSlashCommandCatalog } from '../../claude-slash-command-catalog'
import { createClaudeInitProof } from '../claude-structured-init-proof'
import { createClaudeStartupOutcome } from '../claude-structured-startup-outcome'
import { claudeProviderHandleLink } from '../claude-structured-owner-identity'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

function sessionFor(setModel: ClaudeSession['connection']['setModel']): ClaudeSession {
  return {
    connection: {
      setModel,
      supportedModels: async (): Promise<unknown[]> => []
    } as ClaudeSession['connection'],
    providerSessionId: 'provider-session',
    leafUuid: null,
    turnEndLeafUuid: null,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    prompts: {} as ClaudeSession['prompts'],
    dispatchWaiters: [],
    retiredDispatchWaiters: [],
    replayContentFallbackBlocked: false,
    backgroundTasks: new ClaudeBackgroundTaskTracker(),
    childWork: new ClaudeChildWorkDecoder(),
    commands: new ClaudeSlashCommandCatalog(),
    dispatchSequence: 0,
    optionMutationSequence: 0,
    options: new Map(),
    reportedOptions: {},
    reportedModelMutation: 0,
    confirmedOptions: new Set(),
    appliedInputOptions: new Map(),
    fastModeAtStart: false,
    capabilities: [],
    events: undefined,
    translator: null,
    link: claudeProviderHandleLink({
      sessionId: 'provider-session',
      leafUuid: null,
      resumed: false,
      fence: 1,
      observedAt: 1
    }),
    initialization: {
      proof: createClaudeInitProof(),
      account: undefined,
      resumesTranscript: false,
      claudeConfigDir: '/claude-home',
      cwd: '/work',
      history: { leafUuid: null, covered: true, contextActivity: 0 },
      onLateRefusal: () => {},
      startup: createClaudeStartupOutcome()
    }
  }
}

describe('Claude structured option mutation fencing', () => {
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
