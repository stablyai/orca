import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { CursorStructuredSessionAdapter } from './cursor-structured-session-adapter'
import { cursorAcpFixtureLaunch } from './cursor-acp-protocol-fixture'

const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function fixture(resumeSessionId?: string, options?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'orca-cursor-acp-adapter-'))
  const identity: AgentSessionJournalIdentity = {
    sessionId: 'cursor-adapter-session',
    workspaceId: 'folder:fixture',
    hostId: 'local',
    agent: 'cursor',
    providerHandle: { kind: 'cursor', sessionId: resumeSessionId ?? 'fixture-conversation-1' }
  }
  const journal = await journals.open({ identity, stateDirectory: root })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 7, publish: () => {} })
  const settled = vi.fn()
  const lifecycle = vi.fn()
  const adapter = new CursorStructuredSessionAdapter({
    resolveLaunch: async () => ({
      ...cursorAcpFixtureLaunch(),
      cwd: root,
      ...(resumeSessionId ? { resumeSessionId } : {})
    }),
    onDispatchSettledLate: settled,
    onLifecycleEvent: lifecycle,
    readProcessStartTime: async () => 1700000000000
  })
  cleanups.push(async () => {
    await adapter.closeAll()
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const acquisition = await adapter.acquire({
    identity,
    fence: 7,
    spawnToken: 'cursor-fixture-spawn',
    ...(options ? { options } : {}),
    events: deferred.sink
  })
  const send = (text: string, clientMessageId = 'input-1') =>
    adapter.dispatch({
      sessionId: identity.sessionId,
      fence: 7,
      clientMessageId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
    })
  const items = async () => {
    await deferred.drained()
    return journal.snapshot().items
  }
  return { adapter, acquisition, identity, send, items, settled, lifecycle, deferred }
}

describe('Cursor ACP adapter with the existing durable journal', () => {
  it('records provider ownership and a complete prompt turn without parsing terminal text', async () => {
    const test = await fixture()
    expect(test.acquisition.link.handle).toEqual({
      provider: 'cursor',
      sessionId: 'fixture-conversation-1'
    })
    expect(test.acquisition.process.spawnToken).toBe('cursor-fixture-spawn')
    expect(test.adapter.holdsDispatch('absent')).toBe(false)
    expect(await test.adapter.releaseAcquisition({ sessionId: 'foreign-owner' })).toBe(false)
    expect(await test.adapter.forceCloseSession('foreign-owner')).toBe(false)
    expect(await test.send('protocol fixture response')).toEqual({ state: 'admitted' })
    await vi.waitFor(() => expect(test.settled).toHaveBeenCalledOnce())
    await vi.waitFor(async () =>
      expect(
        (await test.items())
          .map((row) => readAgentJournalTurn(row.body))
          .find((turn) => turn?.state === 'completed')
      ).toMatchObject({ outcome: 'success' })
    )
    const messages = (await test.items()).filter((row) => row.body.kind === 'message')
    expect(messages).toHaveLength(2)
    expect(messages.map((row) => row.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          blocks: [{ type: 'text', text: 'protocol fixture response' }]
        }),
        expect.objectContaining({
          role: 'assistant',
          blocks: [{ type: 'text', text: 'protocol fixture response' }]
        })
      ])
    )
    expect(test.lifecycle).not.toHaveBeenCalled()
  })

  it('holds tool permission until the answer commits and preserves tool completion', async () => {
    const test = await fixture()
    await test.send('approval')
    await vi.waitFor(async () =>
      expect((await test.items()).some((row) => row.body.kind === 'approval')).toBe(true)
    )
    const approval = (await test.items()).find((row) => row.body.kind === 'approval')
    expect(approval).toBeDefined()
    if (!approval) {
      throw new Error('Fixture approval missing')
    }
    const commit = vi.fn(async () => {})
    await test.adapter.answerPrompt({
      sessionId: test.identity.sessionId,
      fence: 7,
      itemId: approval.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'allow' },
      commit
    })
    expect(commit).toHaveBeenCalledOnce()
    await vi.waitFor(async () =>
      expect((await test.items()).find((row) => row.body.kind === 'tool-call')?.body).toMatchObject(
        { state: 'completed', callId: 'tool-1' }
      )
    )
    await expect(
      test.adapter.answerPrompt({
        sessionId: test.identity.sessionId,
        fence: 7,
        itemId: approval.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId: 'allow' },
        commit
      })
    ).rejects.toThrow('no longer waiting')
  })

  it('loads the exact session and keeps replayed history when continuing it', async () => {
    const test = await fixture('exact-saved-provider-id')
    expect(test.acquisition.link).toMatchObject({
      origin: 'resumed',
      handle: { provider: 'cursor', sessionId: 'exact-saved-provider-id' }
    })
    expect((await test.items()).map((row) => row.body)).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        blocks: [{ type: 'text', text: 'fixture replay' }]
      })
    )
    await test.send('continue same fixture session')
    await vi.waitFor(() => expect(test.settled).toHaveBeenCalledOnce())
    expect(agentJournalItemKey(test.settled.mock.calls[0][0].providerIdentity)).toContain(
      'exact-saved-provider-id'
    )
  })

  it('reads and changes only model values reported by ACP', async () => {
    const test = await fixture()
    expect(
      await test.adapter.readOptions({ sessionId: test.identity.sessionId, fence: 7 })
    ).toMatchObject({ current: { model: 'fixture-model', confirmed: ['model'] } })
    await expect(
      test.adapter.setOption({
        sessionId: test.identity.sessionId,
        fence: 7,
        key: 'model',
        value: 'unoffered-model'
      })
    ).rejects.toThrow('did not offer')
    expect(
      await test.adapter.setOption({
        sessionId: test.identity.sessionId,
        fence: 7,
        key: 'model',
        value: 'fixture-model-2'
      })
    ).toEqual({ model: 'fixture-model-2' })
  })

  it('requires matching fences and provider cancellation confirmation', async () => {
    const test = await fixture()
    await test.send('cancel')
    await vi.waitFor(() => expect(test.settled).toHaveBeenCalledOnce())
    await expect(
      test.adapter.cancelTurn({ sessionId: test.identity.sessionId, fence: 6 })
    ).rejects.toThrow('matching live owner')
    expect(
      await test.adapter.cancelTurn({
        sessionId: test.identity.sessionId,
        fence: 7,
        turnId: 'foreign-turn'
      })
    ).toEqual({ cancelled: false })
    expect(await test.adapter.cancelTurn({ sessionId: test.identity.sessionId, fence: 7 })).toEqual(
      { cancelled: true }
    )
    await vi.waitFor(async () =>
      expect(
        (await test.items())
          .map((row) => readAgentJournalTurn(row.body))
          .find((turn) => turn?.outcome === 'cancellation')
      ).toBeDefined()
    )
    expect(await test.adapter.closeSession(test.identity.sessionId)).toBe(true)
    test.adapter.acknowledgeSessionRelease(test.identity.sessionId)
    expect(test.adapter.holdsDispatch(test.identity.sessionId)).toBe(false)
  })
  it('keeps the proven conversation when old terminal options are unavailable, reporting only actual provider state', async () => {
    const test = await fixture(undefined, { model: 'old-terminal-model', effort: 'high' })
    expect(test.acquisition.link.handle).toEqual({
      provider: 'cursor',
      sessionId: 'fixture-conversation-1'
    })
    expect(test.adapter.readOptionRestoreFailures(test.identity.sessionId)).toEqual([
      'model',
      'effort'
    ])
    expect(
      await test.adapter.readOptions({ sessionId: test.identity.sessionId, fence: 7 })
    ).toMatchObject({ current: { model: 'fixture-model', confirmed: ['model'] } })
    expect(await test.send('new choice remains usable')).toEqual({ state: 'admitted' })
    await vi.waitFor(() => expect(test.settled).toHaveBeenCalledOnce())
  })
})
