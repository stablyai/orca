import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomService } from './service'
import type { RoomHarnessRuntime } from './harness-adapter'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { ROOM_CORE_METHODS } from '../rpc/methods/rooms-core'

afterEach(() => setStructuredAgentSessionHost(null))

describe('room durable session metadata', () => {
  it('includes saved options in the first snapshot without waking a sleeping provider', async () => {
    const options = { model: 'gpt-6-astra', effort: 'high' }
    const hold = vi.fn()
    const readOptions = vi.fn()
    const ensure = vi.fn(async () => {
      setStructuredAgentSessionHost({
        deps: { store: { getRecord: () => ({ options }) } },
        hold,
        readOptions
      } as never)
    })
    const service = new RoomService(
      ':memory:',
      { ensureStructuredAgentSessionHost: ensure } as unknown as RoomHarnessRuntime,
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
      const method = ROOM_CORE_METHODS.find(
        (entry) => entry.name === 'rooms.snapshot'
      )! as unknown as {
        handler: (
          params: unknown,
          context: unknown
        ) => Promise<{ snapshot: ReturnType<RoomService['snapshot']> }>
      }
      const { snapshot } = await method.handler(
        { roomId: room.id, readerKey: 'user' },
        { runtime: { getRoomService: () => service } }
      )
      expect(snapshot.participants.find((entry) => entry.id === agent.id)).toMatchObject({
        state: 'sleeping',
        context: { model: 'gpt-6-astra', effort: 'high', usedTokens: null, maxTokens: null }
      })
      expect(ensure).toHaveBeenCalledTimes(1)
      expect(hold).not.toHaveBeenCalled()
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
    setStructuredAgentSessionHost({
      deps: { store: { getRecord: () => ({ options: { model: 'gpt-6-astra', effort: 'high' } }) } }
    } as never)
    const service = new RoomService(':memory:', {} as RoomHarnessRuntime, {})
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
