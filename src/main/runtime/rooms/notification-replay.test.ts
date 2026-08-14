import { describe, expect, it } from 'vitest'
import { RoomDatabase } from './database'
import { replayRoomNotifications } from './notification-replay'

describe('room notification replay', () => {
  it('replays only later agent messages with their notification context', () => {
    const database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      name: 'Research'
    })
    const agent = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab-1:pane-1'
    })
    const baseline = replayRoomNotifications(database, null, 200)
    database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'user',
      actorKind: 'user',
      body: 'Do it'
    })
    const reply = database.messages.create({
      roomId: snapshot.room.id,
      senderId: agent.id,
      senderIdentity: agent.identity,
      actorKind: 'agent',
      body: 'Done',
      enqueueDeliveries: false
    }).message

    const replay = replayRoomNotifications(database, baseline.cursor, 200)

    expect(replay.cursor).toBe(reply.sequence)
    expect(replay.events).toMatchObject([
      {
        type: 'message.created',
        message: { id: reply.id },
        notification: {
          roomName: 'Research',
          worktreeId: 'worktree-1',
          paneKey: 'tab-1:pane-1',
          agent: 'codex'
        }
      }
    ])
    expect(replayRoomNotifications(database, replay.cursor, 200).events).toEqual([])
    database.close()
  })
})
