import { describe, expect, it, vi } from 'vitest'
import {
  restoreClaudeStructuredSessionOptions,
  setClaudeStructuredOption
} from './claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import {
  observeClaudeFastModeFacts,
  observeClaudeUserPermissionMode,
  readClaudeStructuredSessionOptions
} from './claude-structured-session-options'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  restoreClaudePermissionModeAfterApprovedPrompt,
  setClaudeStructuredPermissionMode
} from './claude-structured-permission-mode'
import { readNativeSessionOptionRestoration } from '../native-chat/agent-session-wire/structured-agent-session-option-restoration'

function sessionFor(setModel: ClaudeSession['connection']['setModel']): ClaudeSession {
  return {
    // An empty catalog identifies no model, so the pre-flight refuses nothing and
    // this stays a test about fencing.
    connection: {
      setModel,
      supportedModels: async (): Promise<unknown[]> => []
    } as ClaudeSession['connection'],
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
    commands: new ClaudeSlashCommandCatalog(),
    dispatchSequence: 0,
    optionMutationSequence: 0,
    permissionModeMutationSequence: 0,
    reportedPermissionModeMutation: 0,
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

function permissionModeSession(
  initialMode: 'default' | 'acceptEdits' = 'acceptEdits',
  adoptWrites = true
) {
  let reportedMode: Parameters<ClaudeSession['connection']['setPermissionMode']>[0] = initialMode
  const session = sessionFor(vi.fn(async () => undefined))
  const setPermissionMode = vi.fn<ClaudeSession['connection']['setPermissionMode']>(
    async (mode) => {
      if (adoptWrites) {
        reportedMode = mode === 'plan' ? 'plan' : mode
      }
    }
  )
  const getSettings = vi.fn<ClaudeSession['connection']['getSettings']>(async () => ({
    applied: { permissionMode: reportedMode }
  }))
  session.connection.setPermissionMode = setPermissionMode
  session.connection.getSettings = getSettings
  session.basePermissionMode = initialMode
  session.reportedOptions.permissionMode = initialMode
  session.confirmedOptions.add('permissionMode')
  return { session, setPermissionMode, getSettings }
}

describe('Claude structured plan mode', () => {
  it('keeps autonomous reports fenced after an acquisition with no permission restore', async () => {
    const { session } = permissionModeSession()

    await restoreClaudeStructuredSessionOptions(session, undefined)
    observeClaudeUserPermissionMode(session, { permissionMode: 'plan' })

    expect(session.permissionModeMutationSequence).toBe(1)
    expect(session.reportedPermissionModeMutation).toBe(1)
    expect(session.reportedOptions.permissionMode).toBe('acceptEdits')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
  })

  it('ignores autonomous provider permission reports without a user-owned mutation', () => {
    const { session } = permissionModeSession()
    const optionsChanged = vi.fn()
    session.confirmedOptions.delete('permissionMode')
    session.events = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      optionsChanged
    }

    observeClaudeUserPermissionMode(session, { permissionMode: 'plan' })

    expect(session.reportedOptions.permissionMode).toBe('acceptEdits')
    expect(session.confirmedOptions.has('permissionMode')).toBe(false)
    expect(optionsChanged).not.toHaveBeenCalled()
  })

  it('rejects a permission change while an outcome-unknown send can still start a turn', async () => {
    const { session, setPermissionMode } = permissionModeSession()
    session.dispatchSequence = 1
    session.retiredDispatchWaiters.push({
      resolve: vi.fn(),
      acceptsResult: false,
      clientMessageId: 'unconfirmed-send',
      sentUuid: 'sent-uuid',
      dispatchSequence: 1,
      requestedAt: 1,
      retired: true,
      replayContentKey: 'content'
    })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    ).rejects.toThrow('cannot change while a turn or send is unsettled')

    expect(setPermissionMode).not.toHaveBeenCalled()
  })

  it('does not let an archival replay identity permanently block permission changes', async () => {
    const { session, setPermissionMode } = permissionModeSession()
    session.dispatchSequence = 2
    session.retiredDispatchWaiters.push({
      resolve: vi.fn(),
      acceptsResult: false,
      clientMessageId: 'older-unconfirmed-send',
      sentUuid: 'older-sent-uuid',
      dispatchSequence: 1,
      requestedAt: 1,
      retired: true,
      replayContentKey: 'older-content'
    })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    ).resolves.toMatchObject({ permissionMode: 'plan' })

    expect(setPermissionMode).toHaveBeenCalledWith('plan', { timeoutMs: undefined })
  })

  it('selects plan through set_permission_mode and confirms the readback', async () => {
    const { session, setPermissionMode, getSettings } = permissionModeSession()

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    ).resolves.toMatchObject({ permissionMode: 'plan' })

    expect(setPermissionMode).toHaveBeenCalledWith('plan', { timeoutMs: undefined })
    expect(getSettings).toHaveBeenCalledOnce()
    expect(session.reportedOptions.permissionMode).toBe('plan')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)

    observeClaudeUserPermissionMode(session, { permissionMode: 'acceptEdits' })

    expect(session.reportedOptions.permissionMode).toBe('plan')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
  })

  it('uses a provider status report when get_settings has no permission field', async () => {
    const { session, getSettings } = permissionModeSession()
    const setPermissionMode = vi.fn<ClaudeSession['connection']['setPermissionMode']>(
      async (mode) => {
        observeClaudeUserPermissionMode(session, { permissionMode: mode })
      }
    )
    session.connection.setPermissionMode = setPermissionMode
    getSettings.mockResolvedValue({ applied: {} })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    ).resolves.toMatchObject({ permissionMode: 'plan' })

    expect(setPermissionMode).toHaveBeenCalledWith('plan', { timeoutMs: undefined })
    expect(getSettings).toHaveBeenCalledOnce()
    expect(session.reportedOptions.permissionMode).toBe('plan')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
  })

  it('does not reuse a pre-write report when get_settings omits permission mode', async () => {
    const { session, getSettings } = permissionModeSession()
    getSettings.mockResolvedValue({ applied: {} })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    ).resolves.toMatchObject({ permissionMode: 'plan' })

    expect(session.reportedOptions.permissionMode).toBe('acceptEdits')
    expect(session.confirmedOptions.has('permissionMode')).toBe(false)
  })

  it('keeps an approved plan exit durable while waiting for matching late evidence', async () => {
    const { session, getSettings } = permissionModeSession('acceptEdits', false)
    const optionsChanged = vi.fn()
    session.events = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      optionsChanged
    }
    session.options.set('permissionMode', 'plan')
    session.reportedOptions.permissionMode = 'plan'
    session.confirmedOptions.add('permissionMode')
    getSettings.mockResolvedValue({ applied: {} })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'acceptEdits' }, undefined)
    ).resolves.toEqual({ permissionMode: 'acceptEdits' })

    expect(session.options.get('permissionMode')).toBe('acceptEdits')
    expect(session.reportedOptions.permissionMode).toBe('plan')
    expect(session.confirmedOptions.has('permissionMode')).toBe(false)
    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { permissionMode: 'plan', confirmed: expect.arrayContaining(['permissionMode']) }
    })
    expect(session.confirmedOptions.has('permissionMode')).toBe(false)
    await expect(
      readNativeSessionOptionRestoration({
        adapter: {
          readOptions: async () => readClaudeStructuredSessionOptions(session, undefined)
        },
        sessionId: 'session-1',
        fence: 1,
        priorOptions: { permissionMode: 'acceptEdits' }
      })
    ).resolves.toMatchObject({ options: { permissionMode: 'acceptEdits' } })

    observeClaudeUserPermissionMode(session, { permissionMode: 'plan' })

    expect(session.reportedOptions.permissionMode).toBe('plan')
    expect(session.confirmedOptions.has('permissionMode')).toBe(false)

    observeClaudeUserPermissionMode(session, { permissionMode: 'acceptEdits' })

    expect(session.reportedOptions.permissionMode).toBe('acceptEdits')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
    expect(optionsChanged).toHaveBeenCalledOnce()

    observeClaudeUserPermissionMode(session, { permissionMode: 'plan' })

    expect(session.reportedOptions.permissionMode).toBe('acceptEdits')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
    expect(optionsChanged).toHaveBeenCalledOnce()
  })

  it('does not let a stale base report retire a failed exit retry', async () => {
    const { session, setPermissionMode, getSettings } = permissionModeSession()
    getSettings.mockResolvedValue({ applied: {} })

    await setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    setPermissionMode.mockRejectedValueOnce(
      new ClaudeControlRequestError('set_permission_mode', 'restore rejected')
    )
    await expect(
      setClaudeStructuredPermissionMode(session, 'acceptEdits', undefined, 'keep-requested')
    ).rejects.toThrow('restore rejected')

    const restoration = await readNativeSessionOptionRestoration({
      adapter: {
        readOptions: async () => readClaudeStructuredSessionOptions(session, undefined)
      },
      sessionId: 'session-1',
      fence: 1,
      priorOptions: { permissionMode: 'acceptEdits' }
    })

    expect(restoration?.options.permissionMode).toBe('acceptEdits')
    expect(session.reportedPermissionModeMutation).toBe(0)
    expect(session.permissionModeMutationSequence).toBe(2)
  })

  it('publishes provider-current Plan after durable settlement outruns a failed exit', async () => {
    const { session, getSettings } = permissionModeSession()
    const providerApply = Promise.withResolvers<void>()
    const optionsChanged = vi.fn()
    session.connection.setPermissionMode = vi.fn(() => providerApply.promise)
    getSettings.mockResolvedValue({ applied: { permissionMode: 'plan' } })
    session.options.set('permissionMode', 'plan')
    session.reportedOptions.permissionMode = 'plan'
    session.events = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      optionsChanged
    }
    const settleOptions = vi.fn(async () => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const restoring = restoreClaudePermissionModeAfterApprovedPrompt(
      session,
      { value: 'acceptEdits', options: { permissionMode: 'acceptEdits' } },
      settleOptions
    )
    await vi.waitFor(() =>
      expect(settleOptions).toHaveBeenCalledWith({ permissionMode: 'acceptEdits' })
    )
    expect(optionsChanged).not.toHaveBeenCalled()

    providerApply.reject(new Error('transport failed'))
    await restoring

    expect(optionsChanged).toHaveBeenCalledOnce()
    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { permissionMode: 'plan', confirmed: expect.arrayContaining(['permissionMode']) }
    })
    warning.mockRestore()
  })

  it('publishes a fresh Plan readback while retaining the requested exit retry', async () => {
    const { session, getSettings } = permissionModeSession('acceptEdits', false)
    session.options.set('permissionMode', 'plan')
    session.reportedOptions.permissionMode = 'plan'
    session.confirmedOptions.add('permissionMode')
    getSettings.mockResolvedValue({ applied: { permissionMode: 'plan' } })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'acceptEdits' }, undefined)
    ).resolves.toEqual({ permissionMode: 'acceptEdits' })
    expect(session.confirmedOptions.has('permissionMode')).toBe(false)

    const restoration = await readNativeSessionOptionRestoration({
      adapter: {
        readOptions: async () => readClaudeStructuredSessionOptions(session, undefined)
      },
      sessionId: 'session-1',
      fence: 1,
      priorOptions: { permissionMode: 'acceptEdits' }
    })

    expect(restoration?.options.permissionMode).toBe('acceptEdits')
    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { permissionMode: 'plan', confirmed: expect.arrayContaining(['permissionMode']) }
    })
  })

  it('lets a later explicit Plan choice supersede an unconfirmed exit restore', async () => {
    const { session, getSettings } = permissionModeSession('acceptEdits', false)
    session.options.set('permissionMode', 'plan')
    session.reportedOptions.permissionMode = 'plan'
    session.confirmedOptions.add('permissionMode')
    getSettings.mockResolvedValue({ applied: { permissionMode: 'plan' } })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'acceptEdits' }, undefined)
    ).resolves.toEqual({ permissionMode: 'acceptEdits' })
    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    ).resolves.toEqual({ permissionMode: 'plan' })

    observeClaudeUserPermissionMode(session, { permissionMode: 'acceptEdits' })

    expect(session.options.get('permissionMode')).toBe('plan')
    expect(session.reportedOptions.permissionMode).toBe('plan')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
  })

  it('keeps the requested permission mode visible while provider evidence confirms it', async () => {
    const { session, getSettings } = permissionModeSession()
    session.options.set('permissionMode', 'plan')
    session.confirmedOptions.delete('permissionMode')

    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      permissionModeRestoreValue: 'acceptEdits',
      current: { permissionMode: 'plan' }
    })

    getSettings.mockResolvedValue({ applied: { permissionMode: 'plan' } })
    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { permissionMode: 'plan', confirmed: ['permissionMode'] }
    })
  })

  it('rejects an invalid permission mode before provider dispatch', async () => {
    const { session, setPermissionMode, getSettings } = permissionModeSession()

    await expect(
      setClaudeStructuredOption(
        session,
        { key: 'permissionMode', value: 'retired-mode' },
        undefined
      )
    ).rejects.toThrow('permission mode retired-mode is invalid')

    expect(setPermissionMode).not.toHaveBeenCalled()
    expect(getSettings).not.toHaveBeenCalled()
  })

  it.each(['default', 'bypassPermissions', 'dontAsk', 'auto'] as const)(
    'rejects well-formed but unoffered permission mode %s',
    async (mode) => {
      const { session, setPermissionMode, getSettings } = permissionModeSession('acceptEdits')

      await expect(
        setClaudeStructuredOption(session, { key: 'permissionMode', value: mode }, undefined)
      ).rejects.toThrow(`permission mode ${mode} is not offered by this session`)

      expect(setPermissionMode).not.toHaveBeenCalled()
      expect(getSettings).not.toHaveBeenCalled()
    }
  )

  it('rejects plan mode when the session has no captured restore mode', async () => {
    const { session, setPermissionMode } = permissionModeSession()
    delete session.basePermissionMode

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    ).rejects.toThrow('permission mode plan is not offered by this session')
    expect(setPermissionMode).not.toHaveBeenCalled()
  })

  it('keeps permission ownership across an overlapping model write', async () => {
    const { session, getSettings } = permissionModeSession()
    const permissionApply = Promise.withResolvers<void>()
    session.connection.setPermissionMode = vi.fn(() => permissionApply.promise)

    const enteringPlan = setClaudeStructuredOption(
      session,
      { key: 'permissionMode', value: 'plan' },
      undefined
    )
    await vi.waitFor(() => expect(session.options.get('permissionMode')).toBe('plan'))
    await setClaudeStructuredOption(session, { key: 'model', value: 'sonnet' }, undefined)
    getSettings.mockResolvedValue({ applied: { permissionMode: 'plan' } })
    permissionApply.resolve()

    await expect(enteringPlan).resolves.toMatchObject({ permissionMode: 'plan' })
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
  })

  it('does not let a superseded failed permission write roll back a later one', async () => {
    const { session, setPermissionMode } = permissionModeSession()
    const firstApply = Promise.withResolvers<void>()
    setPermissionMode.mockImplementationOnce(() => firstApply.promise)

    const enteringPlan = setClaudeStructuredOption(
      session,
      { key: 'permissionMode', value: 'plan' },
      undefined
    )
    await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledOnce())
    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'acceptEdits' }, undefined)
    ).resolves.toEqual({})

    firstApply.reject(new Error('older write failed'))
    await expect(enteringPlan).resolves.toEqual({})
    expect(session.options.has('permissionMode')).toBe(false)
    expect(session.reportedOptions.permissionMode).toBe('acceptEdits')
    expect(session.basePermissionMode).toBe('acceptEdits')
  })

  it('closes permission report ownership after a failed manual change rolls back', async () => {
    const { session } = permissionModeSession()
    session.connection.setPermissionMode = vi.fn(async () => {
      throw new Error('transport failed')
    })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'plan' }, undefined)
    ).rejects.toThrow('transport failed')
    observeClaudeUserPermissionMode(session, { permissionMode: 'plan' })

    expect(session.options.has('permissionMode')).toBe(false)
    expect(session.reportedPermissionModeMutation).toBe(session.permissionModeMutationSequence)
    expect(session.reportedOptions.permissionMode).toBe('acceptEdits')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
  })

  it('fences an in-flight permission write when restored options take ownership', async () => {
    const { session, setPermissionMode, getSettings } = permissionModeSession()
    const firstApply = Promise.withResolvers<void>()
    setPermissionMode.mockImplementationOnce(() => firstApply.promise)

    const first = setClaudeStructuredOption(
      session,
      { key: 'permissionMode', value: 'plan' },
      undefined
    )
    await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledOnce())
    getSettings.mockResolvedValue({ applied: { permissionMode: 'plan' } })
    await restoreClaudeStructuredSessionOptions(session, undefined)

    firstApply.resolve()
    await expect(first).resolves.toMatchObject({ permissionMode: 'plan' })
    expect(setPermissionMode).toHaveBeenCalledTimes(2)
    expect(session.options.get('permissionMode')).toBe('plan')
    expect(session.confirmedOptions.has('permissionMode')).toBe(true)
  })

  it('keeps the accepted exit intent durable when readback still reports plan', async () => {
    const { session, setPermissionMode, getSettings } = permissionModeSession('acceptEdits', false)
    session.options.set('permissionMode', 'plan')
    session.reportedOptions.permissionMode = 'plan'
    getSettings.mockResolvedValue({ applied: { permissionMode: 'plan' } })

    await expect(
      setClaudeStructuredOption(session, { key: 'permissionMode', value: 'acceptEdits' }, undefined)
    ).resolves.toEqual({ permissionMode: 'acceptEdits' })

    expect(setPermissionMode).toHaveBeenCalledWith('acceptEdits', { timeoutMs: undefined })
    expect(getSettings).toHaveBeenCalledOnce()
    expect(session.options.get('permissionMode')).toBe('acceptEdits')
    expect(session.reportedOptions.permissionMode).toBe('plan')
    expect(session.confirmedOptions.has('permissionMode')).toBe(false)
  })

  it('retains an approved exit for the next acquisition when its retry fails', async () => {
    const { session } = permissionModeSession('acceptEdits', false)
    session.options.set('permissionMode', 'acceptEdits')
    session.connection.setPermissionMode = vi.fn(async () => {
      throw new ClaudeControlRequestError('set_permission_mode', 'temporarily unavailable')
    })

    await restoreClaudeStructuredSessionOptions(session, undefined)

    expect(session.options.get('permissionMode')).toBe('acceptEdits')
    expect(session.restoreSkippedOptions.has('permissionMode')).toBe(false)
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
    getSettings: async () => ({ effective: { fastMode: reportedFastMode } })
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

  it('rejects definitively unsupported Fast before applying', async () => {
    const { session, applyFlagSettings } = fastModeSession(false)
    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).rejects.toThrow('does not support Fast mode')
    expect(applyFlagSettings).not.toHaveBeenCalled()
  })

  it('does not authorize a new Fast enable when model support is unknown', async () => {
    const { session, applyFlagSettings } = fastModeSession(undefined)

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).rejects.toThrow('does not support Fast mode')
    expect(applyFlagSettings).not.toHaveBeenCalled()
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

  // Turning Fast off needs no support evidence, so it must not pay a catalog round
  // trip — restore replays a stored `false` on every acquire.
  it('reads no catalog to turn Fast off, but does to turn it on', async () => {
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
    expect(reads).toBe(1)
  })

  it('restores explicit Fast off when model support is unknown', async () => {
    const { session, applyFlagSettings } = fastModeSession(undefined)
    session.options.set('fastMode', 'false')

    await restoreClaudeStructuredSessionOptions(session, undefined)

    expect(session.options.get('fastMode')).toBe('false')
    expect(session.restoreSkippedOptions.has('fastMode')).toBe(false)
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: false }, { timeoutMs: undefined })
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

  // The child omits the reason when nothing blocks Fast, so a later unblocked frame is
  // the only all-clear. Without it the first reason latches and the control never returns.
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

    // Switched back to a model that allows Fast: state reported, reason omitted.
    observeClaudeFastModeFacts(session, { fast_mode_state: 'on' })
    expect(session.fastModeDisabledReason).toBeUndefined()
    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      fastModeSupport: { supported: true }
    })
    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'true' })
  })

  it('reconciles an earlier Fast request to a later provider readback', async () => {
    const { session } = fastModeSession(true)
    session.options.set('fastMode', 'true')
    session.connection.getSettings = async () => ({ effective: { fastMode: false } })

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

    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { fastMode: true, fastModeState: 'cooldown', confirmed: ['fastMode'] }
    })
    expect(session.options.get('fastMode')).toBe('true')
    expect(session.confirmedOptions.has('fastMode')).toBe(true)
  })

  it('publishes support and explicit false from running CLI reports', async () => {
    const { session } = fastModeSession(true)
    observeClaudeFastModeFacts(session, {
      fast_mode_state: 'cooldown',
      fast_mode_disabled_reason: null
    })
    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      models: [expect.objectContaining({ id: 'opus', supportsFastMode: true })],
      fastModeSupport: { supported: true },
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

  it('reconciles Fast off when switching to a model without support', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    session.options.set('fastMode', 'true')
    session.connection.supportedModels = async () => [
      { value: 'opus', displayName: 'Opus', supportsFastMode: true },
      { value: 'haiku', displayName: 'Haiku', supportsFastMode: false }
    ]

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'haiku' }, undefined)
    ).resolves.toMatchObject({ model: 'haiku', fastMode: 'false' })
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: false }, { timeoutMs: undefined })
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

    await expect(readClaudeStructuredSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { model: 'haiku', fastMode: false }
    })
    expect(session.options.get('fastMode')).toBe('false')
    expect(session.confirmedOptions.has('fastMode')).toBe(true)
  })

  it('keeps the accepted model when the unsupported-model Fast-off write fails', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    session.options.set('fastMode', 'true')
    session.reportedOptions.fastMode = true
    session.confirmedOptions.add('fastMode')
    session.connection.supportedModels = async () => [
      { value: 'opus', displayName: 'Opus', supportsFastMode: true },
      { value: 'haiku', displayName: 'Haiku', supportsFastMode: false }
    ]
    applyFlagSettings.mockRejectedValueOnce(new Error('flag write failed'))

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'haiku' }, undefined)
    ).resolves.toMatchObject({ model: 'haiku', fastMode: 'false' })
    expect(session.reportedOptions.fastMode).toBe(true)
    expect(session.confirmedOptions.has('fastMode')).toBe(false)
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
  /**
   * A CLI whose catalog answers with nothing identifies no model, so it is not
   * evidence against one — the same rule the model admit-check already applies.
   * Refusing here would have Fast unavailable on every model of a CLI that cannot
   * answer, while a catalog that did list the model and stayed silent about Fast
   * still refuses.
   */
  it('allows Fast on when the catalog identifies no model at all', async () => {
    const { session, applyFlagSettings } = fastModeSession(true)
    session.connection.supportedModels = async () => []

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).resolves.toMatchObject({ fastMode: 'true' })
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: true }, { timeoutMs: undefined })
  })

  it('still refuses Fast on when the catalog lists the model and omits Fast support', async () => {
    const { session, applyFlagSettings } = fastModeSession(undefined)

    await expect(
      setClaudeStructuredOption(session, { key: 'fastMode', value: 'true' }, undefined)
    ).rejects.toThrow('does not support Fast mode')
    expect(applyFlagSettings).not.toHaveBeenCalled()
  })
})

describe('Claude Fast mode reported by the session frame alone', () => {
  /**
   * Measured against a running Claude session: the first `agentSession.options`
   * read carries `fastModeState: 'off'` while `effective.fastMode` is still absent,
   * so the two are not redundant — the frame answers at a moment the boolean has no
   * answer. Without this the picker asks the user to disambiguate a value the
   * provider already reported.
   */
  function frameOnlySession(state: 'off' | 'on' | 'cooldown') {
    const { session } = fastModeSession(true)
    // Settings are silent on Fast, exactly as observed on a fresh session.
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
