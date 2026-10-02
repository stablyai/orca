import { hostTestStub } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomService } from './service'
import { roomHarnessRuntimeFixture } from './room-harness-runtime.test-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { ROOM_CORE_METHODS } from '../rpc/methods/rooms-core'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'

afterEach(() => setStructuredAgentSessionHost(null))

describe('room durable session metadata', () => {
  it('includes saved options in the first snapshot without waking a sleeping provider', async () => {
    const options = { model: 'gpt-6-astra', effort: 'high' }
    const acquire = vi.fn()
    const readOptions = vi.fn()
    const ensure = vi.fn(async () => {
      const host = hostTestStub({ readOptions })
      vi.spyOn(host.deps.adapter, 'acquire').mockImplementation(acquire)
      vi.spyOn(host.deps.store, 'getRecord').mockImplementation(() => ({
        ...agentSessionRecordFixture(),
        options
      }))
      setStructuredAgentSessionHost(host)
    })
    const service = new RoomService(
      ':memory:',
      roomHarnessRuntimeFixture({ ensureStructuredAgentSessionHost: ensure }),
      {}
    )
    try {
      const { room } = service.createRoom({ projectId: 'project', name: 'test' })
      const agent = service.db.participants.add({
        roomId: room.id,
        identity: 'codex',
        displayName: 'codex',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'saved-session', transport: 'machine' }
      })
      service.db.participants.update(agent.id, { state: 'sleeping' })
      vi.spyOn(service, 'activateRoom').mockImplementation(() => new Promise(() => {}))
      const method = ROOM_CORE_METHODS.find((entry) => entry.name === 'rooms.snapshot')!
      const rpcRuntime = new OrcaRuntimeService()
      vi.spyOn(rpcRuntime, 'getRoomService').mockReturnValue(service)
      const { snapshot } = await method.handler(
        { roomId: room.id, readerKey: 'user' },
        { runtime: rpcRuntime }
      )
      expect(snapshot.participants.find((entry) => entry.id === agent.id)).toMatchObject({
        state: 'sleeping',
        context: { model: 'gpt-6-astra', effort: 'high', usedTokens: null, maxTokens: null }
      })
      expect(ensure).toHaveBeenCalledTimes(1)
      expect(acquire).not.toHaveBeenCalled()
      expect(readOptions).not.toHaveBeenCalled()
      options.effort = 'medium'
      expect(service.db.participants.get(agent.id).context.effort).toBe('medium')
      const events: unknown[] = []
      const unsubscribe = service.subscribe(room.id, 'user', (event) => events.push(event))
      expect(events[0]).toMatchObject({
        type: 'snapshot',
        snapshot: {
          participants: expect.arrayContaining([
            expect.objectContaining({
              context: expect.objectContaining({ model: 'gpt-6-astra', effort: 'medium' })
            })
          ])
        }
      })
      unsubscribe()
      setStructuredAgentSessionHost(null)
      ensure.mockRejectedValueOnce(new Error('metadata unavailable'))
      await expect(service.prepareSnapshot(room.id)).resolves.toBeUndefined()
      expect(service.snapshot(room.id).room.id).toBe(room.id)
    } finally {
      service.close()
    }
  })

  it('keeps usage and terminal participants unchanged', () => {
    const host = hostTestStub({})
    vi.spyOn(host.deps.store, 'getRecord').mockReturnValue({
      ...agentSessionRecordFixture(),
      options: { model: 'gpt-6-astra', effort: 'high' }
    })
    setStructuredAgentSessionHost(host)
    const service = new RoomService(':memory:', roomHarnessRuntimeFixture(), {})
    try {
      const { room } = service.createRoom({ projectId: 'project', name: 'test' })
      const p = service.db.participants.add({
        roomId: room.id,
        identity: 'terminal',
        displayName: 'terminal',
        agent: 'codex'
      })
      const context = { ...p.context, model: 'terminal-model', usedTokens: 12, maxTokens: 100 }
      service.db.participants.update(p.id, { context })
      expect(service.db.participants.get(p.id).context).toEqual(context)
      service.db.participants.update(p.id, {
        providerSession: { key: 'session_id', id: 'saved-session', transport: 'machine' }
      })
      expect(service.db.participants.get(p.id).context).toMatchObject({
        model: 'gpt-6-astra',
        effort: 'high',
        usedTokens: 12,
        maxTokens: 100
      })
    } finally {
      service.close()
    }
  })
})
