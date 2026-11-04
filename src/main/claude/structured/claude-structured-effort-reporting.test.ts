import { describe, expect, it, vi } from 'vitest'
import { setClaudeStructuredOption } from './launch/claude-structured-options'
import { readClaudeSettingsEffort } from './launch/claude-structured-session-options'
import { ClaudeControlRequestTimeoutError } from '../claude-agent-sdk-control-requests'
import recordedUltracodeSettings from '../__fixtures__/ultracode-settings.json'
import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'

import {
  USER_MESSAGE,
  acquired,
  adapterFor,
  claudeFrame,
  fakeClaude,
  identityFor,
  recordingJournalSink
} from './claude-structured-session-test-support'

/** Verbatim from Claude Code 2.1.258's get_settings response. */
const REAL_SETTINGS = {
  applied: { model: 'claude-opus-5[1m]', effort: 'high', advisor: null, ultracode: false },
  effective: { model: 'claude-opus-5[1m]', effortLevel: 'high', env: {} },
  sources: {}
}

function sessionWith(
  reported: string | null,
  calls: string[] = [],
  listed?: { model: string; catalog: readonly Record<string, unknown>[] }
) {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every session member the option paths under test read.
    session: {
      options: new Map<string, string>(listed ? [['model', listed.model]] : []),
      reportedOptions: {} as { model?: string; effort?: string },
      optionMutationSequence: 0,
      reportedModelMutation: 0,
      confirmedOptions: new Set<string>(),
      appliedInputOptions: new Map(),
      connection: {
        supportedModels: async () => {
          calls.push('list_models')
          return [...(listed?.catalog ?? [])]
        },
        setModel: async (model: string) => {
          calls.push(`set_model:${model}`)
        },
        applyFlagSettings: async (settings: { effortLevel?: string }) => {
          // The CLI accepts and ignores unknown effort values.
          calls.push(`apply:${settings.effortLevel}`)
        },
        getSettings: async () => {
          calls.push('get_settings')
          return reported === null
            ? { applied: {}, effective: {}, sources: {} }
            : { applied: { effort: reported }, effective: { effortLevel: reported }, sources: {} }
        }
      },
      startup: { state: 'proven' }
    } as unknown as ClaudeSession,
    calls
  }
}

describe('Claude effort reporting', () => {
  it('reads the effort get_settings reports', () => {
    expect(readClaudeSettingsEffort(REAL_SETTINGS)).toBe('high')
  })

  it.each([
    [
      'the provider stops reporting it',
      { applied: { effort: 'high' }, effective: {}, sources: {} }
    ],
    ['the payload carries no effective block', { applied: { effort: 'high' } }],
    ['the request failed outright', null]
  ])('reports no effort when %s', (_case, settings) => {
    expect(readClaudeSettingsEffort(settings)).toBeNull()
  })

  it('publishes the effort from get_settings, which system/init never carries', async () => {
    const claude = fakeClaude({ settings: REAL_SETTINGS })
    const adapter = await acquired(claude)

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { effort: 'high' }
    })
  })

  it('keeps ordinary effort visible when a configured workflow uses another effort', async () => {
    const settings = {
      ...REAL_SETTINGS,
      applied: { ...REAL_SETTINGS.applied, ultracode: true }
    }
    const adapter = await acquired(fakeClaude({ settings }))
    expect((await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current.effort).toBe(
      'high'
    )
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'configured-workflow',
        body: USER_MESSAGE,
        executionOptions: {},
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted', ranOptions: { effort: 'high' } })
    await adapter.closeAll()
  })

  it('keeps a configured workflow at launch without confirming saved ordinary XHigh', async () => {
    const claude = fakeClaude({
      settings: { applied: { effort: 'xhigh', ultracode: true }, effective: {} }
    })
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'configured-workflow',
      options: { effort: 'xhigh' },
      events: recordingJournalSink()
    })
    const current = (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
    expect(current.effort).toBe('xhigh')
    expect(current.confirmed ?? []).not.toContain('effort')
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'configured-workflow',
        body: USER_MESSAGE,
        executionOptions: { effort: 'xhigh' },
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted', ranOptions: { effort: 'ultracode' } })
    expect(claude.connections[0]!.calls.map(({ subtype }) => subtype)).not.toContain(
      'apply_flag_settings'
    )
    const connection = claude.connections[0]!
    connection.getSettings = async () => recordedUltracodeSettings.configured
    claudeFrame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    for (const clientMessageId of ['fast-on', 'after-fast']) {
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId,
          body: USER_MESSAGE,
          executionOptions: { effort: 'xhigh', fastMode: 'true' },
          fence: 7
        })
      ).resolves.toMatchObject({ state: 'admitted' })
      claudeFrame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }
    expect(
      connection.calls
        .filter(({ subtype }) => subtype === 'apply_flag_settings')
        .map(({ params }) => params?.settings)
    ).toEqual([{ fastMode: true }, { effortLevel: 'xhigh' }])
    await adapter.closeAll()
  })

  it('leaves an attempted workflow after lost enable and exit acknowledgements', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'uncertain-workflow',
      options: { effort: 'xhigh' },
      events: recordingJournalSink()
    })
    const connection = claude.connections[0]!
    connection.getSettings = async () => null
    const settings: unknown[] = []
    connection.applyFlagSettings = async (input) => {
      settings.push(input)
      if (settings.length < 3) {
        throw new ClaudeControlRequestTimeoutError('apply_flag_settings')
      }
    }
    for (const [clientMessageId, effort, state] of [
      ['enable', 'ultracode', 'rejected'],
      ['exit-unanswered', 'xhigh', 'rejected'],
      ['exit-retry', 'xhigh', 'admitted']
    ] as const) {
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId,
          body: USER_MESSAGE,
          executionOptions: { effort },
          fence: 7
        })
      ).resolves.toMatchObject({ state })
    }
    expect(settings).toEqual([
      { effortLevel: 'xhigh', ultracode: true },
      { effortLevel: 'xhigh', ultracode: false },
      { effortLevel: 'xhigh', ultracode: false }
    ])
    expect(connection.sent).toHaveLength(1)
    await adapter.closeAll()
  })

  it('leaves the effort unreported when the session never learns one', async () => {
    const model = 'claude-opus-5[1m]'
    const claude = fakeClaude({
      settings: { applied: { model }, effective: { model }, sources: {} }
    })
    const adapter = await acquired(claude)

    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.effort).toBeUndefined()
    expect(options.current.model).toBe(model)
  })

  it('keeps the init fixture free of an effort the real frame never sends', async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(fakeClaude(), {}, events)
    // Live: init arrives when the first command starts a cycle, not at startup.
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'seed-cycle',
      body: USER_MESSAGE,
      fence: 7
    })
    const init = events.flatMap((event) =>
      event.type === 'message' && event.message.subtype === 'init' ? [event.message] : []
    )

    expect(init).toHaveLength(1)
    expect(init[0]).toHaveProperty('model')
    expect(Object.keys(init[0])).not.toContain('effortLevel')
  })
})

describe('Claude effort readback', () => {
  it('records an effort the child did not adopt without vouching for it', async () => {
    const { session, calls } = sessionWith('high')

    // The native enum is valid; a different readback cannot veto a successful control.
    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'low' }, undefined)
    ).resolves.toEqual({ effort: 'low' })
    expect(session.confirmedOptions.has('effort')).toBe(false)
    // The child's own answer is kept rather than discarded with the refusal.
    await vi.waitFor(() => expect(session.reportedOptions.effort).toBe('high'))
    expect(calls).toEqual(['apply:low', 'get_settings'])
  })

  it('records an effort the child confirms', async () => {
    const { session } = sessionWith('low')

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'low' }, undefined)
    ).resolves.toEqual({ effort: 'low' })
  })

  it('records the request when the readback is unavailable', async () => {
    const { session } = sessionWith(null)

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'low' }, undefined)
    ).resolves.toEqual({ effort: 'low' })
  })
})
