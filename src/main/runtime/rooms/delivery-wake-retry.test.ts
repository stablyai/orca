import { expect, it } from 'vitest'
import { RoomDatabase } from './database'
import { claimReadyRoomDelivery, probeRoomDeliveryReadiness } from './delivery-machine-readiness'
import { deliverRoomDelivery } from './delivery-execution'
import type { RoomHarnessAdapter } from './harness-adapter'

it.each(['machine', 'terminal'])(
  'counts failed %s wake attempts instead of stranding pending delivery',
  async (transport) => {
    const db = new RoomDatabase(':memory:')
    try {
      const snapshot = db.createRoom({ projectId: 'p', name: 'Retry' })
      const participant = db.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'w',
        ...(transport === 'machine'
          ? {
              providerSession: {
                key: 'session_id' as const,
                id: 'session',
                transport: 'machine' as const
              }
            }
          : { paneKey: 'pane', terminalHandle: 'terminal' })
      })
      db.participants.add({
        roomId: snapshot.room.id,
        identity: 'sibling',
        displayName: 'Sibling',
        agent: 'codex'
      })
      db.participants.update(participant.id, { state: 'error' })
      let delivery = db.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0]!.id,
        senderIdentity: 'user',
        actorKind: 'user',
        body: 'retry',
        targetParticipantIds: [participant.id]
      }).deliveries[0]!
      let isRunningAgent = true
      let status: 'working' | 'permission' | null = 'working'
      const adapters = {
        codex: {
          status: async () => ({ handle: 'session', isRunningAgent, status })
        } as unknown as RoomHarnessAdapter
      }
      for (const blocked of ['working', 'permission', null] as const) {
        status = blocked
        expect(await probeRoomDeliveryReadiness(db, adapters, delivery)).toEqual({
          kind: 'blocked'
        })
      }
      isRunningAgent = false
      for (let attempt = 1; attempt <= 5; attempt++) {
        const claimed = await claimReadyRoomDelivery(
          db,
          adapters,
          delivery,
          async () => {
            throw new Error('wake must run inside counted attempt')
          },
          () => true
        )
        expect(claimed?.attempts).toBe(attempt)
        await deliverRoomDelivery({
          db,
          adapters,
          delivery: claimed!,
          attachments: {} as never,
          confirmations: { discard: () => undefined } as never,
          emit: () => undefined,
          ensureParticipantReady: async () => {
            throw new Error('conversation_not_found')
          },
          steer: false,
          moveRejectedSteerToHead: false,
          disposed: () => false
        })
        delivery = db.messages.deliveries.get(delivery.id)
        expect(delivery.state).toBe(attempt < 5 ? 'pending' : 'failed')
        expect(delivery.attemptHistory?.at(-1)).toMatchObject({
          attempt,
          phase: 'waking',
          error: 'conversation_not_found'
        })
        expect(delivery.nextAttemptAt).toBeGreaterThan(Date.now())
      }
      expect(db.messages.deliveries.workState(snapshot.room.id)).toBe('idle')
    } finally {
      db.close()
    }
  }
)
