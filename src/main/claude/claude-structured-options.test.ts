import { describe, expect, it, vi } from 'vitest'
import { setClaudeStructuredOption } from './claude-structured-options'
import { applyClaudeMessageOptions } from './claude-structured-message-options'
import { resetClaudeRetiredModel } from './claude-structured-retired-model'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import { ClaudeControlRequestTimeoutError } from './claude-agent-sdk-control-requests'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import { createClaudeInitProof } from './structured/claude-structured-init-proof'
import { claudeProviderHandleLink } from './structured/claude-structured-owner-identity'
import {
  observeClaudeFastModeFacts,
  readClaudeStructuredSessionOptions,
  refreshClaudeStructuredSessionOptions
} from './claude-structured-session-options'

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
    launchedModel: null,
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
      onLateRefusal: () => {}
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

function fastModeSession(supportsFastMode: boolean | undefined) {
  let reportedFastMode = false
  const applyFlagSettings = vi.fn(async (settings: { fastMode?: boolean }) => {
    if (typeof settings.fastMode === 'boolean') {
      reportedFastMode = settings.fastMode
    }
  })
  const session = sessionFor(vi.fn(async () => undefined))
  session.options.set('model', 'opus')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the literal supplies every connection member this fixture's code paths call, and the spread carries the rest from sessionFor.
  session.connection = {
    ...session.connection,
    supportedModels: async () => [
      {
        value: 'opus',
        resolvedModel: 'claude-opus-current',
        displayName: 'Opus',
        ...(supportsFastMode === undefined ? {} : { supportsFastMode })
      }
    ],
    applyFlagSettings,
    getSettings: async () => ({ effective: { fastMode: reportedFastMode } }),
    getContextUsage: async () => ({})
  } as ClaudeSession['connection']
  return { session, applyFlagSettings }
}

describe('Claude structured Fast mode', () => {
  it('applies absolute on and off values and confirms provider readback', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'true' })
    expect(session.confirmedOptions.has('fastMode')).toBe(true)
    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'false' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'false' })
    expect(applyFlagSettings).toHaveBeenNthCalledWith(
      1,
      { fastMode: true },
      { timeoutMs: undefined }
    )
    expect(applyFlagSettings).toHaveBeenNthCalledWith(
      2,
      { fastMode: false },
      { timeoutMs: undefined }
    )
  })

  it.each([undefined, false])(
    'allows explicit Fast off when model support is %s',
    async (supportsFastMode) => {
      const { session, applyFlagSettings } = fastModeSession(supportsFastMode)

      await expect(
        setClaudeStructuredOption(session, { key: 'fastMode', value: 'false' }, undefined)
      ).resolves.toMatchObject({ fastMode: 'false' })
      expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: false }, { timeoutMs: undefined })
    }
  )

  // Host admission already checked the installed catalog.
  it('applies Fast picks without a child catalog round trip', async () => {
    const { session } = fastModeSession(true)
    const listed = session.connection.supportedModels
    let reads = 0
    session.connection.supportedModels = async (...args: Parameters<typeof listed>) => {
      reads += 1
      return listed(...args)
    }

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'false' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'false' })
    expect(reads).toBe(0)

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'true' })
    expect(reads).toBe(0)
  })

  it('resolves the running CLI default model before applying Fast', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    session.options.delete('model')
    session.connection.supportedModels = async () => [
      { value: 'default', resolvedModel: 'claude-opus-current', displayName: 'Default' },
      {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-current',
        displayName: 'Opus (1M context)',
        supportsFastMode: true
      }
    ]

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'true' })
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: true }, { timeoutMs: undefined })
  })

  it('rejects Fast on when the running session reports a blocking reason', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    session.fastModeDisabledReason = 'extra_usage_disabled'

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).rejects.toThrow('extra_usage_disabled')
    expect(applyFlagSettings).not.toHaveBeenCalled()
  })

  it('clears a blocking reason once a later frame reports state without one', async () => {
    const { session } = fastModeSession(true)

    observeClaudeFastModeFacts(session, {
      fast_mode_state: 'off',
      fast_mode_disabled_reason: 'model_not_allowed'
    })
    expect(session.fastModeDisabledReason).toBe('model_not_allowed')
    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      fastModeSupport: { supported: false, reason: 'model_not_allowed' }
    })

    observeClaudeFastModeFacts(session, { fast_mode_state: 'on' })
    expect(session.fastModeDisabledReason).toBeUndefined()
    expect(
      (await readClaudeStructuredSessionOptions(session, undefined)).fastModeSupport
    ).toBeUndefined()
    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'true' })
  })

  it('reconciles an earlier Fast request to a later provider readback', async () => {
    const { session } = fastModeSession(true)
    session.options.set('fastMode', 'true')
    session.connection.getSettings = async () => ({ effective: { fastMode: false } })
    await refreshClaudeStructuredSessionOptions(
      session,
      undefined,
      () => true,
      () => {}
    )

    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { fastMode: false, confirmed: ['fastMode'] }
    })
    expect(session.options.get('fastMode')).toBe('false')
    expect(session.confirmedOptions.has('fastMode')).toBe(true)
  })

  it('keeps the Fast preference on during cooldown when settings report it on', async () => {
    const { session } = fastModeSession(true)
    session.options.set('fastMode', 'false')
    session.connection.getSettings = async () => ({ effective: { fastMode: true } })
    observeClaudeFastModeFacts(session, { fast_mode_state: 'cooldown' })
    await refreshClaudeStructuredSessionOptions(
      session,
      undefined,
      () => true,
      () => {}
    )

    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { fastMode: true, fastModeState: 'cooldown', confirmed: ['fastMode'] }
    })
    expect(session.options.get('fastMode')).toBe('true')
    expect(session.confirmedOptions.has('fastMode')).toBe(true)
  })

  it('reports actual Fast values without child capability rows', async () => {
    const { session } = fastModeSession(true)
    observeClaudeFastModeFacts(session, {
      fast_mode_state: 'cooldown',
      fast_mode_disabled_reason: null
    })
    await refreshClaudeStructuredSessionOptions(
      session,
      undefined,
      () => true,
      () => {}
    )
    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: {
        model: 'opus',
        fastMode: false,
        fastModeState: 'cooldown',
        confirmed: ['fastMode']
      }
    })
  })

  it('hides Fast when the running CLI reports a blocking session reason', async () => {
    const { session } = fastModeSession(true)
    observeClaudeFastModeFacts(session, {
      fast_mode_state: 'off',
      fast_mode_disabled_reason: 'not_first_party'
    })

    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      fastModeSupport: { supported: false, reason: 'not_first_party' },
      current: { fastMode: false, fastModeState: 'off' }
    })
  })

  it('keeps Fast on across a model switch while support discovery is transient', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    session.options.set('fastMode', 'true')
    session.connection.supportedModels = async () => {
      throw new Error('catalog temporarily unavailable')
    }

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'haiku' }, undefined)
    ).resolves.toMatchObject({ model: 'haiku', fastMode: 'true' })
    expect(applyFlagSettings).not.toHaveBeenCalled()
  })

  it('reconciles a transient model switch once support is definitively unavailable', async () => {
    const { session } = fastModeSession(true)
    session.options.set('fastMode', 'true')
    session.connection.supportedModels = async () => {
      throw new Error('catalog temporarily unavailable')
    }
    await setClaudeStructuredOption(session, { key: 'model', value: 'haiku' }, undefined)
    session.connection.supportedModels = async () => [
      { value: 'opus', displayName: 'Opus', supportsFastMode: true },
      { value: 'haiku', displayName: 'Haiku', supportsFastMode: false }
    ]
    await refreshClaudeStructuredSessionOptions(
      session,
      undefined,
      () => true,
      () => {}
    )

    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { model: 'haiku', fastMode: false }
    })
    expect(session.options.get('fastMode')).toBe('false')
    expect(session.confirmedOptions.has('fastMode')).toBe(true)
  })

  it('treats an unrecognized provider disabled reason as unavailable', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    observeClaudeFastModeFacts(session, {
      fast_mode_state: 'off',
      fast_mode_disabled_reason: 'future_entitlement_rule'
    })

    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      fastModeSupport: { supported: false, reason: 'future_entitlement_rule' }
    })
    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).rejects.toThrow('future_entitlement_rule')
    expect(applyFlagSettings).not.toHaveBeenCalled()
  })
})

describe('Claude Fast mode against a catalog that identifies nothing', () => {
  it('allows Fast on when the catalog identifies no model at all', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    session.connection.supportedModels = async () => []

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'true' })
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: true }, { timeoutMs: undefined })
  })
})

describe('Claude Fast mode reported by the session frame alone', () => {
  function frameOnlySession(state: 'off' | 'on' | 'cooldown') {
    const { session } = fastModeSession(true)
    session.connection.getSettings = async () => ({ effective: { effortLevel: 'high' } })
    observeClaudeFastModeFacts(session, { fast_mode_state: state })
    return session
  }

  it('reports Fast off from the session frame when settings never carry it', async () => {
    const result = await readClaudeStructuredSessionOptions(frameOnlySession('off'), undefined)

    expect(result.current.fastMode).toBe(false)
    expect(result.current.confirmed).toContain('fastMode')
  })

  it('reads a throttled session as on, since cooldown throttles routing not the pick', async () => {
    await expect(
      readClaudeStructuredSessionOptions(frameOnlySession('on'), undefined)
    ).resolves.toMatchObject({ current: { fastMode: true } })
    await expect(
      readClaudeStructuredSessionOptions(frameOnlySession('cooldown'), undefined)
    ).resolves.toMatchObject({ current: { fastMode: true, fastModeState: 'cooldown' } })
  })

  it('stays unknown when neither settings nor a session frame report Fast', async () => {
    const { session } = fastModeSession(true)
    session.connection.getSettings = async () => ({ effective: { effortLevel: 'high' } })

    const result = await readClaudeStructuredSessionOptions(session, undefined)

    expect(result.current.fastMode).toBeUndefined()
  })
})

describe("Claude's model the chat never chose", () => {
  it('marks the listed default it falls back to, never a model the chat runs', async () => {
    const { session } = fastModeSession(true)
    const current = async () =>
      (await readClaudeStructuredSessionOptions(session, undefined)).current
    expect((await current()).defaulted).toBeUndefined()
    session.options.delete('model')
    expect(await current()).toMatchObject({ defaulted: ['model'] })
    session.options.set('model', 'default')
    expect(await current()).toMatchObject({ defaulted: ['model'] })
  })
})

describe('Claude structured option write under the request deadline', () => {
  it('completes successful literal effort writes without optional settings confirmation', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    session.connection.getSettings = () => new Promise(() => {})
    const held = [...session.options]
    const applied = [...session.appliedInputOptions]
    const sequence = session.optionMutationSequence
    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'banana' }, undefined)
    ).rejects.toThrow(
      'Claude effort is invalid; choose low, medium, high, xhigh, or max and send again.'
    )
    expect(applyFlagSettings).not.toHaveBeenCalled()
    expect([...session.options]).toEqual(held)
    expect([...session.appliedInputOptions]).toEqual(applied)
    expect(session.optionMutationSequence).toBe(sequence)
    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).resolves.toMatchObject({ effort: 'high' })
    expect(applyFlagSettings).toHaveBeenCalledWith(
      { effortLevel: 'high' },
      { timeoutMs: undefined }
    )
    expect(session.appliedInputOptions.get('effort')).toBe('high')
    expect(session.confirmedOptions.has('effort')).toBe(false)
  })

  it("keeps a timed-out client write as the deadline's own error, not a rejection", async () => {
    const session = sessionFor(async () => {
      throw new ClaudeControlRequestTimeoutError('set_model')
    })

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'sonnet' }, 10)
    ).rejects.toBeInstanceOf(ClaudeControlRequestTimeoutError)
  })
})

describe('Claude applied inputs across native writer effects', () => {
  it('retires old-model Fast refusal and reissues explicit inputs after promotion, reset and failure', async () => {
    const setModel = vi.fn<ClaudeSession['connection']['setModel']>().mockResolvedValue(undefined)
    const session = sessionFor(setModel)
    const flags = vi
      .fn<ClaudeSession['connection']['applyFlagSettings']>()
      .mockResolvedValue(undefined)
    session.connection.applyFlagSettings = flags
    session.connection.getSettings = () => new Promise(() => {})
    session.fastModeDisabledReason = 'model_not_allowed'
    await applyClaudeMessageOptions(
      session,
      { model: 'opus[1m]', effort: 'high', fastMode: 'true' },
      undefined
    )
    expect(flags.mock.calls.map(([settings]) => settings)).toEqual([
      { effortLevel: 'high' },
      { fastMode: true }
    ])
    expect(session.fastModeDisabledReason).toBeUndefined()
    // Fast can promote the native model; the next supplied model/effort must reach their controls.
    await applyClaudeMessageOptions(session, { model: 'opus[1m]', effort: 'high' }, undefined)
    expect(setModel).toHaveBeenCalledTimes(2)
    expect(flags.mock.calls.filter(([settings]) => settings.effortLevel === 'high')).toHaveLength(2)
    resetClaudeRetiredModel(session, {}, 'chat', 'opus[1m]')
    await vi.waitFor(() =>
      expect(setModel).toHaveBeenLastCalledWith(undefined, { timeoutMs: undefined })
    )
    await applyClaudeMessageOptions(session, { effort: 'high' }, undefined)
    expect(flags.mock.calls.filter(([settings]) => settings.effortLevel === 'high')).toHaveLength(3)
    flags.mockRejectedValueOnce(new Error('native effort failure'))
    await expect(applyClaudeMessageOptions(session, { effort: 'low' }, undefined)).rejects.toThrow(
      'native effort failure'
    )
    await applyClaudeMessageOptions(session, { effort: 'low' }, undefined)
    expect(flags.mock.calls.filter(([settings]) => settings.effortLevel === 'low')).toHaveLength(2)
    const count = setModel.mock.calls.length + flags.mock.calls.length
    await applyClaudeMessageOptions(session, {}, undefined)
    expect(setModel.mock.calls.length + flags.mock.calls.length).toBe(count)
    setModel.mockImplementationOnce(async () => {
      observeClaudeFastModeFacts(session, { fast_mode_disabled_reason: 'model_not_allowed' })
    })
    await applyClaudeMessageOptions(session, { model: 'haiku' }, undefined)
    await expect(
      applyClaudeMessageOptions(session, { fastMode: 'true' }, undefined)
    ).rejects.toThrow('Fast mode is unavailable')
  })
})
