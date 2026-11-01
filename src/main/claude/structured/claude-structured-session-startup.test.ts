import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adapterAtPublishFor,
  fakeClaude,
  claudeFrame,
  identityFor,
  USER_MESSAGE,
  recordingJournalSink,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'
import { claudeOpened } from './claude-structured-startup-settled-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import { CLAUDE_INITIALIZE_TIMEOUT_MS } from './claude-structured-session-startup'
import { providerRequestTimeoutOf } from '../../provider-process/provider-request-timeout'

const owned: {
  claude: ReturnType<typeof fakeClaude>
  adapter: ReturnType<typeof adapterAtPublishFor>
  opens: Promise<unknown>[]
}[] = []

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }

function adapterFor(claude: ReturnType<typeof fakeClaude>) {
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterAtPublishFor(claude, {}, events)
  const opens: Promise<unknown>[] = []
  owned.push({ claude, adapter, opens })
  const open = adapter.open.bind(adapter)
  adapter.open = (request) => {
    const result = open(request)
    void result.catch(() => {})
    opens.push(result)
    return result
  }
  return { adapter, events }
}

describe('Claude host-awaited open', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    try {
      for (const { claude } of owned) {
        claude.dispose()
      }
      for (const { adapter, opens } of owned.splice(0)) {
        await Promise.allSettled(opens)
        await adapter.closeAll()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a missing saved conversation to the final startup failure row', async () => {
    const frame = JSON.parse(
      readFileSync(
        new URL('../__fixtures__/claude-missing-conversation.jsonl', import.meta.url),
        'utf8'
      )
    )
    const claude = fakeClaude({ holdInit: true })
    const { adapter } = adapterFor(claude)
    const appendItem = vi.fn()
    await adapter.acquire({
      ...ACQUIRE,
      events: { ...recordingJournalSink(), appendItem }
    })
    // Replay under the fixture's acquisition identity, preserving the captured error payload.
    claudeFrame(claude.connections[0], { ...frame, session_id: PROVIDER_SESSION_ID })
    expect(appendItem.mock.calls.filter(([, body]) => body.kind === 'status')).toHaveLength(0)
  })

  // Recorded failure result; the in-doubt and ambiguous-write orderings are constructed.
  it.each([
    ['before its echo', 'admitted'],
    ['after idle left it in doubt', 'admitted'],
    ['after an ambiguous write', 'unknown']
  ])('keeps the failure row of a result that answers a send %s', async (path, state) => {
    const result = readFileSync(
      new URL('../__fixtures__/claude-lifecycle-capture-auth-failed.jsonl', import.meta.url),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).frame)
      .find((frame) => frame?.type === 'result')
    const claude = fakeClaude({ replayUuid: null })
    const { adapter } = adapterFor(claude)
    const appendItem = vi.fn()
    await adapter.acquire({ ...ACQUIRE, events: { ...recordingJournalSink(), appendItem } })
    await claudeOpened(adapter, 'session-1')
    const connection = claude.connections[0]!
    if (path === 'after an ambiguous write') {
      const send = connection.send
      connection.send = async (...args) => {
        await send(...args)
        throw new Error('input pump stopped')
      }
    }
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'unechoed',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toMatchObject({ state })
    const sentUuid = connection.sent[0]!.uuid
    if (path === 'after idle left it in doubt') {
      claudeFrame(connection, {
        type: 'command_lifecycle',
        command_uuid: sentUuid,
        state: 'started'
      })
      claudeFrame(connection, {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'idle-1'
      })
    }
    // Correlated to this dispatch with no user or assistant echo first; its waiter may be retired.
    claudeFrame(connection, {
      ...result,
      session_id: PROVIDER_SESSION_ID,
      user_message_uuid: sentUuid,
      user_message_uuids: [sentUuid]
    })
    expect(
      appendItem.mock.calls.filter(([, body]) => body.kind === 'status' && body.tone === 'error')
    ).toHaveLength(1)
  })

  // SDK-typed shape; ordering constructed
  it.each([
    ['bypassPermissions', 'full-access'],
    ['plan', 'plan'],
    [null, null],
    [undefined, 'accept-edits']
  ] as const)(
    'preserves the startup status permission report %s over init',
    async (mode, expected) => {
      const claude = fakeClaude()
      const adapter = adapterAtPublishFor({
        ...claude,
        openConnection: async (...args) => {
          const connection = await claude.openConnection(...args)
          const observed = claude.connections[0]
          if (!observed) {
            throw new Error('missing test connection')
          }
          claudeFrame(observed, {
            type: 'system',
            subtype: 'init',
            permissionMode: 'acceptEdits',
            model: 'claude-sonnet-5'
          })
          claudeFrame(observed, {
            type: 'system',
            subtype: 'status',
            status: null,
            ...(mode === undefined ? {} : { permissionMode: mode })
          })
          return connection
        }
      })
      await adapter.acquire({ ...ACQUIRE, options: { permissionMode: 'own' } })
      const opened = await claudeOpened(adapter, 'session-1')
      expect(opened.reportedOptions?.reportedPermissionMode).toBe(expected)
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
          .reportedPermissionMode
      ).toBe(expected)
      const connection = claude.connections[0]
      if (!connection) {
        throw new Error('missing test connection')
      }
      expect(connection.launch.options.permissionMode).toBeUndefined()
      expect(connection.calls.some((call) => call.subtype === 'set_permission_mode')).toBe(false)
      await adapter.closeAll()
    }
  )

  it('refreshes only present owned permission reports through the existing options signal', async () => {
    const claude = fakeClaude()
    const { adapter, events } = adapterFor(claude)
    await adapter.acquire({ ...ACQUIRE, options: { permissionMode: 'own' } })
    await claudeOpened(adapter, 'session-1')
    const connection = claude.connections[0]
    if (!connection) {
      throw new Error('missing test connection')
    }
    for (const [frame, expected, changed] of [
      [
        { subtype: 'init', permissionMode: 'acceptEdits', model: 'claude-haiku-4-5' },
        'accept-edits',
        true
      ],
      [{ subtype: 'status', status: null, permissionMode: 'default' }, 'ask', true],
      [{ subtype: 'status', status: 'compacting' }, 'ask', false],
      [{ subtype: 'init', model: 'claude-haiku-4-5' }, 'ask', false],
      [{ subtype: 'status', status: null, permissionMode: 'plan' }, 'plan', true],
      [{ subtype: 'status', status: null, permissionMode: null }, null, true],
      [
        { subtype: 'status', permissionMode: 'bypassPermissions', session_id: 'foreign' },
        null,
        false
      ]
    ] as const) {
      const before = events.filter((event) => event.type === 'options-reported').length
      claudeFrame(connection, { type: 'system', ...frame })
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
          .reportedPermissionMode
      ).toBe(expected)
      expect(events.filter((event) => event.type === 'options-reported').length - before).toBe(
        changed ? 1 : 0
      )
    }
    expect(connection.calls.some((call) => call.subtype === 'set_permission_mode')).toBe(false)
    await adapter.closeAll()
  })

  it('publishes the owned process as starting before initialize answers', async () => {
    const claude = fakeClaude({ initDelayMs: 12_000 })
    const { adapter, events } = adapterFor(claude)
    const acquisition = await adapter.acquire(ACQUIRE)
    expect(acquisition).toMatchObject({ process: { pid: 4321 } })
    expect(acquisition.link).toBeUndefined()
    expect(claude.connections[0].calls).toEqual([])
    expect(events.some((event) => event.type === 'options')).toBe(false)

    const open = claudeOpened(adapter, 'session-1')
    await vi.advanceTimersByTimeAsync(11_999)
    expect(claude.connections[0].calls.map((call) => call.subtype)).toEqual(['initialize'])
    await vi.advanceTimersByTimeAsync(1)
    await expect(open).resolves.toMatchObject({
      link: expect.objectContaining({ handle: expect.objectContaining({ agent: 'claude' }) }),
      reportedOptions: expect.any(Object)
    })
    expect(events.map((event) => event.type)).not.toContain('started')
    await adapter.closeAll()
  })

  it('returns from open without waiting for optional settings', async () => {
    let answerSettings: (value: unknown) => void = () => {}
    const settings = new Promise<unknown>((resolve) => {
      answerSettings = resolve
    })
    const claude = fakeClaude({ settings })
    const { adapter, events } = adapterFor(claude)
    try {
      await adapter.acquire(ACQUIRE)
      const opened = await claudeOpened(adapter, 'session-1')
      expect(opened.reportedOptions).toBeDefined()
      expect(claude.connections[0].calls.map((call) => call.subtype)).toContain('get_settings')
      expect(events.some((event) => event.type === 'options-reported')).toBe(false)
      answerSettings({ applied: { model: 'claude-haiku-4-5' }, effective: {} })
      await vi.waitFor(() =>
        expect(events.find((event) => event.type === 'options-reported')).toMatchObject({
          reportedOptions: { model: 'claude-haiku-4-5' }
        })
      )
      await adapter.closeAll()
    } finally {
      answerSettings({})
    }
  })

  it('applies a Fast choice at message input when launch settings cannot carry it', async () => {
    let fastMode = false
    const claude = fakeClaude({
      initModels: [{ value: 'claude-sonnet-5', displayName: 'Sonnet', supportsFastMode: true }],
      routes: {
        apply_flag_settings: () => {
          fastMode = true
        }
      }
    })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterAtPublishFor(
      claude,
      { options: { extraArgs: { settings: '/repo/claude.json' } } },
      events
    )
    await adapter.acquire({ ...ACQUIRE, options: { fastMode: 'true' } })
    await claudeOpened(adapter, 'session-1')
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'options-reported')).toBe(true)
    )
    const connection = claude.connections[0]!
    expect(connection.calls.filter((call) => call.subtype === 'apply_flag_settings')).toEqual([])
    connection.getSettings = async () => ({ effective: { effortLevel: 'high', fastMode } })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'fast-choice',
        body: USER_MESSAGE,
        executionOptions: { fastMode: 'true' },
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(connection.calls.filter((call) => call.subtype === 'apply_flag_settings')).toEqual([
      { subtype: 'apply_flag_settings', params: { settings: { fastMode: true } } }
    ])
    expect(connection.sent).toHaveLength(1)
    await adapter.closeAll()
  })

  it('rejects an advertised signed-out initialize answer for the host to close once', async () => {
    const claude = fakeClaude({ initAccount: { tokenSource: 'none', apiKeySource: 'none' } })
    const { adapter } = adapterFor(claude)
    await adapter.acquire(ACQUIRE)
    await expect(claudeOpened(adapter, 'session-1')).rejects.toThrow('not signed in')
    expect(claude.connections[0].closeCount).toBe(0)
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('rejects a frame that proves a different provider session', async () => {
    const claude = fakeClaude({ initSessionId: 'foreign-session' })
    const { adapter } = adapterFor(claude)
    await adapter.acquire(ACQUIRE)
    await expect(claudeOpened(adapter, 'session-1')).rejects.toThrow('provider session expected')
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('fails open when initialize does not answer within its own bound', async () => {
    const claude = fakeClaude({ initDelayMs: 10 * 60_000 })
    const { adapter } = adapterFor(claude)
    await adapter.acquire(ACQUIRE)
    const open = claudeOpened(adapter, 'session-1').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(CLAUDE_INITIALIZE_TIMEOUT_MS)
    const error = await open
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('did not answer initialize')
    expect(providerRequestTimeoutOf(error)).toEqual({
      method: 'initialize',
      timeoutMs: CLAUDE_INITIALIZE_TIMEOUT_MS
    })
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('lets the host abort a silent initialize wait and close the owned process', async () => {
    const claude = fakeClaude({ initDelayMs: 12_000 })
    const { adapter } = adapterFor(claude)
    const acquisition = await adapter.acquire(ACQUIRE)
    const controller = new AbortController()
    const open = adapter.open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquisition.acquisitionGeneration,
      signal: controller.signal
    })
    controller.abort(new Error('host start expired'))
    await expect(open).rejects.toThrow('host start expired')
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })
})
