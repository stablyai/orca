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
import type { ClaudeStructuredLaunch } from './launch/claude-structured-launch-resolution'
import { claudeRecord } from './journal/claude-structured-item-translation'
import { startupAcquisitionRefusal } from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { providerDiagnosticOf } from '../../../shared/agent-session/failures/agent-session-failure'

const owned: {
  claude: ReturnType<typeof fakeClaude>
  adapter: ReturnType<typeof adapterAtPublishFor>
  opens: Promise<unknown>[]
}[] = []

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }

const fixture = (name: string): Record<string, unknown>[] =>
  readFileSync(new URL(`../__fixtures__/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const MISSING = fixture('claude-missing-conversation')[0]!
const AUTH_FAILED = fixture('claude-lifecycle-capture-auth-failed')
  .map((line) => claudeRecord(line.frame))
  .find((frame) => frame?.type === 'result')!
const errorRows = (appendItem: ReturnType<typeof vi.fn>) =>
  appendItem.mock.calls.filter(([, body]) => body.kind === 'status' && body.tone === 'error')

function adapterFor(
  claude: ReturnType<typeof fakeClaude>,
  launch: Partial<ClaudeStructuredLaunch> = {}
) {
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterAtPublishFor(claude, launch, events)
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

  // Recorded results; the send orderings after open are constructed, receipt ids omitted where named.
  it.each([
    ['missing conversation after open, before any send', 1],
    ['send before its echo', 1],
    ['send idle left in doubt', 1],
    ['ambiguous write', 1],
    ['/goal answered without ids', 1],
    ['started /goal answered without ids', 1]
  ] as const)('reports a failure result (%s) in %i rows', async (path, rows) => {
    const claude = fakeClaude({ replayUuid: null })
    const { adapter } = adapterFor(claude)
    const appendItem = vi.fn()
    await adapter.acquire({ ...ACQUIRE, events: { ...recordingJournalSink(), appendItem } })
    const connection = claude.connections[0]!
    let result = MISSING
    await claudeOpened(adapter, 'session-1')
    if (!path.startsWith('missing conversation')) {
      result = AUTH_FAILED
      if (path === 'ambiguous write') {
        const send = connection.send
        connection.send = async (...args) => {
          await send(...args)
          throw new Error('input pump stopped')
        }
      }
      const goal = path.includes('/goal')
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId: 'unechoed',
          body: goal
            ? { ...USER_MESSAGE, blocks: [{ type: 'text', text: '/goal task' }] }
            : USER_MESSAGE,
          fence: 7
        })
      ).resolves.toMatchObject({ state: path === 'ambiguous write' ? 'unknown' : 'admitted' })
      const sentUuid = connection.sent[0]!.uuid
      if (path === 'send idle left in doubt' || path === 'started /goal answered without ids') {
        claudeFrame(connection, {
          type: 'command_lifecycle',
          command_uuid: sentUuid,
          state: 'started'
        })
      }
      if (path === 'send idle left in doubt') {
        claudeFrame(connection, {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
          uuid: 'idle-1'
        })
      }
      // No user or assistant echo first; older CLIs omit the receipt ids.
      result = goal
        ? { ...result, user_message_uuid: undefined, user_message_uuids: undefined }
        : { ...result, user_message_uuid: sentUuid, user_message_uuids: [sentUuid] }
    }
    claudeFrame(connection, { ...result, session_id: PROVIDER_SESSION_ID })
    expect(errorRows(appendItem)).toHaveLength(rows)
  })

  // Recorded results; the orderings are constructed. A resumed turn's result may arrive without an echo.
  const RESUMED = { ...AUTH_FAILED, num_turns: 0, user_message_uuid: '', user_message_uuids: [] }
  const evidence = [
    ['a receipt', { ...RESUMED, user_message_uuid: 'resumed-user' }],
    ['a receipt list', { ...RESUMED, user_message_uuids: ['resumed-user'] }],
    ['a resume reason', { ...RESUMED, resume_reason: 'host_draining' }],
    ['model turns', { ...RESUMED, num_turns: 1 }],
    ['no input', MISSING]
  ] as const
  it.each(
    (['initialize', 'catch-up'] as const).flatMap((phase) =>
      evidence.map(([named, result]) => [named, phase, result] as const)
    )
  )('a startup failure result naming %s during %s', async (_named, phase, result) => {
    const claude = fakeClaude({ holdInit: phase === 'initialize', initProof: 'none' })
    const { adapter } = adapterFor(claude, {
      resumesTranscript: true,
      ...(phase === 'catch-up' ? { resumeLeafUuid: 'saved-leaf' } : {})
    })
    const appendItem = vi.fn()
    const catchingUp = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ ok: true }>()
    const written = () => {
      catchingUp.resolve()
      return release.promise
    }
    await adapter.acquire({
      ...ACQUIRE,
      events: {
        ...recordingJournalSink(),
        appendItem,
        ...(phase === 'catch-up' ? { written } : {})
      }
    })
    const connection = claude.connections[0]!
    const open = claudeOpened(adapter, 'session-1')
    if (phase === 'catch-up') {
      await catchingUp.promise
    }
    claudeFrame(connection, { ...result, session_id: PROVIDER_SESSION_ID })
    connection.initialization.resolve({})
    if (result !== MISSING) {
      // A turn's own failure keeps its row; it does not fail the open.
      release.resolve({ ok: true })
      await expect(open).resolves.toHaveProperty('link')
      expect(errorRows(appendItem)).toHaveLength(1)
      expect(connection.sent).toHaveLength(0)
      return
    }
    // The open fails at once, catch-up still held, so its final startup row is the only report.
    const error = await open.catch((failure: unknown) => failure)
    release.resolve({ ok: true })
    expect(startupAcquisitionRefusal(error)?.reason).toBe('savedConversationMissing')
    expect(providerDiagnosticOf(error)).toEqual({
      text: 'No conversation found with session ID: 00000000-0000-4000-8000-00000000dead',
      audience: 'log'
    })
    expect(errorRows(appendItem)).toHaveLength(0)
  })

  it('fails the open with a startup failure Claude reported before publication', async () => {
    const claude = fakeClaude({ initProof: 'none' })
    const openConnection: typeof claude.openConnection = async (...args) => {
      const connection = await claude.openConnection(...args)
      claudeFrame(claude.connections.at(-1)!, { ...MISSING, session_id: PROVIDER_SESSION_ID })
      return connection
    }
    const { adapter } = adapterFor({ ...claude, openConnection })
    const appendItem = vi.fn()
    await adapter.acquire({ ...ACQUIRE, events: { ...recordingJournalSink(), appendItem } })
    const error = await claudeOpened(adapter, 'session-1').catch((failure: unknown) => failure)
    expect(startupAcquisitionRefusal(error)?.reason).toBe('savedConversationMissing')
    expect(errorRows(appendItem)).toHaveLength(0)
    // A child's failure is never the start's.
    claudeFrame(claude.connections[0]!, {
      ...MISSING,
      session_id: PROVIDER_SESSION_ID,
      parent_tool_use_id: 'child-1'
    })
    expect(errorRows(appendItem)).toHaveLength(1)
  })

  it('lets a late frame fail neither a ready acquisition nor its replacement', async () => {
    const claude = fakeClaude({ initProof: 'none' })
    const { adapter } = adapterFor(claude)
    const appendItem = vi.fn()
    const events = { ...recordingJournalSink(), appendItem }
    await adapter.acquire({ ...ACQUIRE, events })
    await claudeOpened(adapter, 'session-1')
    const ready = claude.connections[0]!
    claudeFrame(ready, { ...MISSING, session_id: PROVIDER_SESSION_ID })
    expect(errorRows(appendItem)).toHaveLength(1)
    await adapter.closeSession('session-1')
    await adapter.acquire({ ...ACQUIRE, events })
    claudeFrame(ready, { ...MISSING, session_id: PROVIDER_SESSION_ID })
    await expect(claudeOpened(adapter, 'session-1')).resolves.toHaveProperty('link')
    claudeFrame(claude.connections[1]!, { ...MISSING, session_id: PROVIDER_SESSION_ID })
    expect(errorRows(appendItem)).toHaveLength(2)
  })

  it('leaves an open Stop aborted to Stop when Claude then reports a startup failure', async () => {
    const claude = fakeClaude({ holdInit: true, initProof: 'none' })
    const { adapter } = adapterFor(claude)
    const appendItem = vi.fn()
    const acquisition = await adapter.acquire({
      ...ACQUIRE,
      events: { ...recordingJournalSink(), appendItem }
    })
    const controller = new AbortController()
    const open = adapter.open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquisition.acquisitionGeneration,
      signal: controller.signal
    })
    controller.abort(new Error('stopped by the person'))
    claudeFrame(claude.connections[0]!, { ...MISSING, session_id: PROVIDER_SESSION_ID })
    await expect(open).rejects.toThrow('stopped by the person')
    expect(errorRows(appendItem)).toHaveLength(0)
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
