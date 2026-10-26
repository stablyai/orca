import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import {
  closePiRpcAdapterFixtures,
  file,
  sessionId,
  setup
} from './rpc-session-adapter.test-fixture'
import { agentSessionLaunchFolderMissing } from '../runtime/agent-session-launch-directory'

afterEach(closePiRpcAdapterFixtures)

describe('Pi RPC session ownership and delivery', () => {
  it('refuses a floating chat whose folder is gone with the reason the person reads', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    h.resolveLaunch.mockRejectedValueOnce(agentSessionLaunchFolderMissing('/gone/floating'))
    await expect(h.adapter.acquire({ ...h.input, fence: 8 })).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'launchFolderMissing'
    })
    expect(h.connections).toHaveLength(1)
  })

  it('does not spawn a start cancelled while resolving its workspace', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    const launch = await h.resolveLaunch.mock.results[0]?.value
    const resolving = Promise.withResolvers<NonNullable<typeof launch>>()
    h.resolveLaunch.mockImplementationOnce(() => resolving.promise)
    const controller = new AbortController()
    const started = h.adapter.acquire({ ...h.input, fence: 8, signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error('Pi closed while starting'))
    await expect(started).rejects.toThrow('closed while starting')
    expect(h.connections).toHaveLength(1)
    await expect(h.adapter.acquire({ ...h.input, fence: 9 })).resolves.toMatchObject({
      process: { pid: 4123 }
    })
    resolving.resolve(launch!)
    await Promise.resolve()
    expect(h.connections).toHaveLength(2)
  })

  it('persists final events after exit while journal writes are blocked', async () => {
    const h = await setup()
    const gate = Promise.withResolvers<void>()
    try {
      const blocked = h.rig.journal.readInOrder(() => {
        expect(
          h.rig.eventSink.tryAppendItem?.(
            { provider: 'legacy', agent: 'pi', sessionId, recordId: 'before' },
            { kind: 'status', tone: 'info', text: 'before' },
            { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          )
        ).toEqual({ accepted: true })
        return gate.promise
      })
      vi.useFakeTimers()
      h.connection.receive({
        type: 'extension_ui_request',
        id: 'last-dialog',
        method: 'input',
        title: 'Final tail'
      })
      h.connection.exit()
      let completed = false
      const written = h.rig.eventSink.written?.().then((result) => {
        completed = true
        return result
      })
      await vi.advanceTimersByTimeAsync(2_001)
      expect(h.lifecycle).toHaveBeenCalledOnce()
      h.adapter.acknowledgeSessionRelease(sessionId)
      await h.adapter.drainObservedExits()
      expect(completed).toBe(false)
      gate.resolve()
      await blocked
      expect(await written).toEqual({ ok: true })
      expect(
        (await h.rig.rows()).some(
          (row) => row.body.kind === 'question' && row.body.question === 'Final tail'
        )
      ).toBe(true)
    } finally {
      gate.resolve()
      vi.useRealTimers()
    }
  })

  it('lets a new acquisition proceed while the released child drains final stdout', async () => {
    const h = await setup()
    h.connection.deferExit = true
    await h.adapter.closeSession(sessionId)
    h.adapter.acknowledgeSessionRelease(sessionId)
    await expect(h.adapter.acquire({ ...h.input, fence: 8 })).resolves.toMatchObject({
      process: { pid: 4123 }
    })
    let drained = false
    const delivery = h.adapter.drainObservedExits().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    h.connection.exit()
    await delivery
    expect(h.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ fence: 7, cause: 'requested-close' })
    )
  })

  it('preserves an unexpected failure cause during forced cleanup', async () => {
    const h = await setup()
    await h.adapter.forceCloseSession(sessionId)
    await h.adapter.drainObservedExits()
    expect(h.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'unexpected-exit', reason: 'Pi event sink failed' })
    )
  })
  it('records the spawned child before the first startup RPC and links the native file', async () => {
    const h = await setup({ effort: 'high', unknown: 'old-value' })
    expect(h.onSpawned).toHaveBeenCalledWith({
      hostId: 'local',
      pid: 4123,
      processStartTimeMs: 12345,
      spawnToken: 'spawn-token'
    })
    expect(h.acquired.process).toEqual(h.onSpawned.mock.calls[0]?.[0])
    expect(h.acquired.link).toBeUndefined()
    expect(h.started.link).toMatchObject({
      handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: file },
      origin: 'created',
      mintedAtFence: 7
    })
    expect(h.connection.requests).not.toContain('set_thinking_level')
    await vi.waitFor(() => expect(h.connection.requests).toContain('get_commands'))
  })

  it('admits a send before Pi confirms it and settles only after journal acceptance', async () => {
    const h = await setup()
    const result = await h.adapter.dispatch({
      sessionId,
      fence: 7,
      clientMessageId: 'send-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    })
    expect(result).toEqual({ state: 'admitted' })
    expect(h.settled).not.toHaveBeenCalled()
    h.connection.receive({ type: 'agent_start' })
    expect(h.settled).toHaveBeenCalledWith({
      sessionId,
      clientMessageId: 'send-1',
      fence: 7,
      outcome: {
        state: 'accepted',
        providerIdentity: { provider: 'orca', clientMessageId: 'send-1' }
      }
    })
    expect(h.connection.sent[0]).toMatchObject({ type: 'prompt', message: 'hello' })
  })

  it('holds each send from its handover until it settles, and none whose write failed', async () => {
    const h = await setup()
    const send = (clientMessageId: string) =>
      h.adapter.dispatch({
        sessionId,
        fence: 7,
        clientMessageId,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] }
      })
    vi.spyOn(h.connection, 'send').mockRejectedValueOnce(new Error('stdin closed'))
    await expect(send('lost')).resolves.toMatchObject({ state: 'unknown' })
    expect(h.adapter.heldSends(sessionId)).toEqual(new Set())

    await send('first')
    expect(h.adapter.heldSends(sessionId)).toEqual(new Set(['first']))
    h.connection.receive({ type: 'agent_start' })
    await send('steer')
    expect(h.adapter.heldSends(sessionId)).toEqual(new Set(['steer']))
  })

  it('applies each sent model before effort and before prompting Pi', async () => {
    const h = await setup()
    h.connection.requestOverride = (command) =>
      command === 'set_thinking_level' ? Promise.resolve({}) : undefined
    const result = await h.adapter.dispatch({
      sessionId,
      fence: 7,
      clientMessageId: 'choice-send',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'chosen' }] },
      executionOptions: { model: 'anthropic/model-2', effort: 'low' }
    })
    expect(result).toEqual({ state: 'admitted' })
    expect(h.connection.requests.slice(-2)).toEqual(['set_model', 'set_thinking_level'])
    expect(h.connection.sent).toMatchObject([{ type: 'prompt', message: 'chosen' }])
  })

  it('sends model-only choices away from the opening model, back, and away again', async () => {
    const h = await setup({}, undefined, { thinkingLevel: 'medium' })
    h.connection.requestOverride = (command) =>
      command === 'set_thinking_level' ? Promise.resolve({}) : undefined
    for (const [clientMessageId, model] of [
      ['away', 'anthropic/model-2'],
      ['back', 'anthropic/model-1'],
      ['again', 'anthropic/model-2']
    ]) {
      await expect(
        h.adapter.dispatch({
          sessionId,
          fence: 7,
          clientMessageId,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: clientMessageId }]
          },
          executionOptions: { model }
        })
      ).resolves.toEqual({ state: 'admitted' })
    }
    // Back on the opening model, its opening effort is restored; elsewhere Pi keeps its own.
    expect(h.connection.requests.filter((command) => command.startsWith('set_'))).toEqual([
      'set_model',
      'set_model',
      'set_thinking_level',
      'set_model'
    ])
    expect(h.connection.sent).toMatchObject([
      { message: 'away' },
      { message: 'back' },
      { message: 'again' }
    ])
  })

  it('rejects a known-unsent prompt when an option times out and preserves Stop reason', async () => {
    const h = await setup()
    const timeout = new Error('Pi did not answer set_model')
    h.connection.requestOverride = (command) =>
      command === 'set_model' ? Promise.reject(timeout) : undefined
    const input = {
      sessionId,
      fence: 7,
      clientMessageId: 'unsent',
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'go' }]
      },
      executionOptions: { model: 'anthropic/model-2' }
    }
    await expect(h.adapter.dispatch(input)).rejects.toMatchObject({
      name: 'AgentSessionOptionRejectedError'
    })
    expect(h.connection.sent).toEqual([])
    const controller = new AbortController()
    controller.abort(timeout)
    await expect(h.adapter.dispatch({ ...input, signal: controller.signal })).rejects.toBe(timeout)
  })

  it('re-establishes opening A after an unanswered unary B and ignores B’s late answer', async () => {
    const h = await setup()
    const unanswered = Promise.withResolvers<unknown>()
    const controller = new AbortController()
    h.connection.requestOverride = (command) =>
      command === 'set_model' ? unanswered.promise : undefined
    const pick = h.adapter.setOption({
      sessionId,
      fence: 7,
      key: 'model',
      value: 'anthropic/model-2',
      signal: controller.signal
    })
    await vi.waitFor(() => expect(h.connection.requests).toContain('set_model'))
    controller.abort(new Error('Stop'))
    await expect(pick).rejects.toThrow('Stop')
    h.connection.requestOverride = (command) =>
      command === 'set_thinking_level' ? Promise.resolve({}) : undefined
    await expect(
      h.adapter.dispatch({
        sessionId,
        fence: 7,
        clientMessageId: 'restore',
        executionOptions: { model: 'anthropic/model-1', effort: 'low' },
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'A again' }] }
      })
    ).resolves.toEqual({ state: 'admitted' })
    expect(h.connection.requests.filter((command) => command === 'set_model')).toHaveLength(2)
    unanswered.resolve({})
    await Promise.resolve()
    expect((await h.adapter.readOptions({ sessionId, fence: 7 })).current.model).toBe(
      'anthropic/model-1'
    )
  })

  it('rejects stale fences and a Stop for a different turn before sending abort', async () => {
    const h = await setup()
    await expect(
      h.adapter.dispatch({
        sessionId,
        fence: 6,
        clientMessageId: 'stale',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'x' }] }
      })
    ).rejects.toThrow('not live under this fence')
    await h.adapter.dispatch({
      sessionId,
      fence: 7,
      clientMessageId: 'send-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'x' }] }
    })
    h.connection.receive({ type: 'agent_start' })
    expect(
      await h.adapter.cancelTurn({
        sessionId,
        fence: 7,
        turnId: 'other',
        resolveLiveTurnId: () => h.rig.assembler.openTurnId
      })
    ).toEqual({ cancelled: false })
    expect(h.connection.requests).not.toContain('abort')
    expect((await h.adapter.cancelTurn({ sessionId, fence: 7 })).cancelled).toBe(true)
    expect(h.connection.requests).toContain('abort')
    expect(await h.adapter.closeSession(sessionId)).toBe(true)
    expect(h.connection.closed).toBe(true)
  })

  it('stops a run Pi starts on an idle session without a send', async () => {
    const h = await setup()
    h.connection.receive({ type: 'agent_start' })
    await vi.waitFor(async () => expect((await h.rig.turns())[0]?.state).toBe('running'))
    expect((await h.adapter.cancelTurn({ sessionId, fence: 7 })).cancelled).toBe(true)
    expect(h.connection.requests).toContain('abort')
    h.connection.receive({ type: 'agent_settled' })
    await vi.waitFor(async () => expect((await h.rig.turns())[0]?.outcome).toBe('cancellation'))
  })

  it('keeps a pending manual compaction cancellable and reports root/tree proof honestly', async () => {
    const h = await setup()
    const turnId = 'manual-compact'
    const command = {
      clientMessageId: 'compact-1',
      turnId,
      identity: { provider: 'orca' as const, clientMessageId: 'compact-1' },
      resultIdentity: { provider: 'orca' as const, clientMessageId: 'compact-result' },
      running: { kind: 'turn' as const, turnId, state: 'running' as const }
    }
    let release: (() => void) | undefined
    h.connection.requestOverride = (name) =>
      name === 'compact'
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : undefined
    const compact = h.adapter.compact({ sessionId, fence: 7, command })
    expect((await h.adapter.cancelTurn({ sessionId, fence: 7 })).cancelled).toBe(true)
    expect(h.connection.requests).toContain('abort')
    release?.()
    await compact
    h.connection.closeResult = { root: 'exited', tree: 'unverifiable' }
    await expect(h.adapter.closeSession(sessionId)).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
  })

  it('ends the host command row under its original identity after a no-op compaction', async () => {
    const h = await setup()
    const command = {
      clientMessageId: 'compact-1',
      turnId: 'manual-compact',
      identity: { provider: 'orca' as const, clientMessageId: 'compact-turn' },
      resultIdentity: { provider: 'orca' as const, clientMessageId: 'compact-result' },
      running: { kind: 'turn' as const, turnId: 'manual-compact', state: 'running' as const }
    }
    h.rig.journal.appendItem(command.identity, agentJournalTurnBody(command.running), {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    h.connection.requestOverride = (name) =>
      name === 'compact'
        ? Promise.reject(new JsonlRpcResponseError(name, 'Nothing to compact (session too small)'))
        : undefined
    expect(await h.adapter.compact({ sessionId, fence: 7, command })).toEqual({
      state: 'accepted',
      providerIdentity: null
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(
      (await h.rig.rows()).find((row) => row.itemId === agentJournalItemKey(command.identity))?.body
    ).toMatchObject({ kind: 'turn', state: 'completed', outcome: 'success' })
    expect(
      (await h.rig.rows()).some((row) => row.body.kind === 'status' && row.body.tone === 'warning')
    ).toBe(true)
  })

  it('answers a live dialog once after commit and does not claim it after dismissal', async () => {
    const h = await setup()
    h.connection.receive({
      type: 'extension_ui_request',
      id: 'input-1',
      method: 'editor',
      title: 'Edit',
      prefill: 'draft'
    })
    const row = (await h.rig.rows()).find((item) => item.body.kind === 'question')
    expect(row?.body).toMatchObject({
      kind: 'question',
      freeTextInput: { allowEmpty: true, initialValue: 'draft' }
    })
    if (!row) {
      throw new Error('dialog row missing')
    }
    let release: (() => void) | undefined
    const commit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const response = {
      kind: 'answers' as const,
      answers: [{ questionId: 'input-1', optionIds: [], other: '' }]
    }
    const first = h.adapter.answerPrompt({
      sessionId,
      fence: 7,
      itemId: row.itemId,
      kind: 'question',
      response,
      commit
    })
    await expect(
      h.adapter.answerPrompt({
        sessionId,
        fence: 7,
        itemId: row.itemId,
        kind: 'question',
        response,
        commit: vi.fn()
      })
    ).rejects.toThrow('no longer waiting')
    release?.()
    await first
    expect(commit).toHaveBeenCalledTimes(1)
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'input-1',
      value: ''
    })
    await expect(
      h.adapter.dismissPrompt({
        sessionId,
        fence: 7,
        itemId: row.itemId,
        answer: true,
        commit: vi.fn()
      })
    ).rejects.toThrow('no longer waiting')
  })

  it('releases a failed dialog commit for a later dismissal, with one provider reply', async () => {
    const h = await setup()
    h.connection.receive({
      type: 'extension_ui_request',
      id: 2,
      method: 'confirm',
      title: 'Continue?'
    })
    const row = (await h.rig.rows()).find((item) => item.body.kind === 'approval')
    if (!row) {
      throw new Error('approval row missing')
    }
    await expect(
      h.adapter.answerPrompt({
        sessionId,
        fence: 7,
        itemId: row.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId: 'yes' },
        commit: async () => {
          throw new Error('CAS lost')
        }
      })
    ).rejects.toThrow('CAS lost')
    expect(h.connection.sent).toEqual([])
    let release: (() => void) | undefined
    const dismiss = h.adapter.dismissPrompt({
      sessionId,
      fence: 7,
      itemId: row.itemId,
      answer: true,
      commit: () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    })
    await expect(
      h.adapter.answerPrompt({
        sessionId,
        fence: 7,
        itemId: row.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId: 'no' },
        commit: vi.fn()
      })
    ).rejects.toThrow('no longer waiting')
    release?.()
    await dismiss
    expect(h.connection.sent).toEqual([{ type: 'extension_ui_response', id: 2, cancelled: true }])
  })

  it('reports unexpected child exit once and preserves an unproven root on close', async () => {
    const h = await setup()
    h.connection.exit(new Error('provider died'))
    await h.adapter.drainObservedExits()
    h.connection.exit(new Error('duplicate exit'))
    await h.adapter.drainObservedExits()
    expect(h.lifecycle).toHaveBeenCalledTimes(1)
    expect(h.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ended',
        sessionId,
        fence: 7,
        acquisitionGeneration: h.acquired.acquisitionGeneration,
        cause: 'unexpected-exit',
        reason: 'provider died'
      })
    )

    const other = await setup()
    other.connection.closeResult = { root: 'unverifiable', tree: null }
    expect(await other.adapter.closeSession(sessionId)).toBe(false)
  })
})
