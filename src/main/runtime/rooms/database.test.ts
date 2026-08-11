import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { RoomDatabase } from './database'

describe('RoomDatabase', () => {
  const databases: RoomDatabase[] = []
  const directories: string[] = []

  afterEach(() => {
    while (databases.length > 0) {
      databases.pop()?.close()
    }
    while (directories.length > 0) {
      rmSync(directories.pop()!, { recursive: true, force: true })
    }
  })

  function memory(): RoomDatabase {
    const database = new RoomDatabase(':memory:')
    databases.push(database)
    return database
  }

  function createRoom(database: RoomDatabase) {
    return database.createRoom({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      name: 'Research',
      userIdentity: 'egor'
    })
  }

  it('creates a project-scoped room with durable user identity', () => {
    const database = memory()
    const snapshot = createRoom(database)

    expect(snapshot.room.projectId).toBe('project-1')
    expect(snapshot.room.worktreeId).toBe('worktree-1')
    expect(snapshot.room.loopLimit).toBe(0)
    expect(snapshot.participants).toMatchObject([
      { identity: 'egor', displayName: 'You', actorKind: 'user', agent: null }
    ])
    expect(database.core.list('project-1')).toHaveLength(1)
    expect(database.core.list('another-project')).toHaveLength(0)
  })

  it('persists rooms, messages, and delivery state across process restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-rooms-'))
    directories.push(directory)
    const path = join(directory, 'rooms.db')
    const first = new RoomDatabase(path)
    const snapshot = createRoom(first)
    const agent = first.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const created = first.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: '@claude inspect this',
      mentions: ['claude']
    })
    expect(created.deliveries).toMatchObject([{ participantId: agent.id, state: 'pending' }])
    first.activities.upsert({
      participantId: agent.id,
      identity: agent.identity,
      state: 'working',
      kind: 'command',
      detail: 'git status',
      messages: [
        {
          id: 'hook:call-1',
          role: 'tool',
          blocks: [{ type: 'tool-call', name: 'exec_command', input: { cmd: 'git status' } }],
          timestamp: 10,
          source: 'hook'
        }
      ],
      startedAt: 10,
      updatedAt: 10,
      anchorSequence: created.message.sequence
    })
    first.participants.update(agent.id, { terminalSurfaceVisible: true })
    first.close()

    const second = new RoomDatabase(path)
    databases.push(second)
    expect(second.core.list('project-1')).toHaveLength(1)
    expect(second.core.get(snapshot.room.id).worktreeId).toBe('worktree-1')
    expect(second.participants.get(agent.id).terminalSurfaceVisible).toBe(true)
    expect(second.messages.list(snapshot.room.id, null, 20).messages).toMatchObject([
      { id: created.message.id, body: '@claude inspect this', mentions: ['claude'] }
    ])
    expect(second.messages.deliveries.listDue()).toMatchObject([
      { messageId: created.message.id, participantId: agent.id, state: 'pending' }
    ])
    expect(second.snapshot(snapshot.room.id).activities).toMatchObject([
      {
        participantId: agent.id,
        messages: [{ id: 'hook:call-1' }],
        anchorSequence: created.message.sequence
      }
    ])
  })

  it('extends the participant state constraint for hibernation on legacy databases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-rooms-'))
    directories.push(directory)
    const path = join(directory, 'rooms.db')
    const first = new RoomDatabase(path)
    const snapshot = createRoom(first)
    const agent = first.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude',
      worktreeId: 'worktree-1',
      paneKey: 'tab:claude',
      terminalHandle: 'term-claude',
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    first.close()

    // Downgrade to the pre-sleeping constraint the way an old build wrote it.
    const raw = new SyncDatabase(path)
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      CREATE TABLE room_participants_legacy AS
        SELECT id, room_id, identity, display_name, actor_kind, agent, role_id, worktree_id,
          pane_key, terminal_handle, provider_session_json, process_incarnation, state,
          context_json, last_seen_at, created_at, updated_at
        FROM room_participants;
      DROP TABLE room_participants;
      CREATE TABLE room_participants (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        identity TEXT NOT NULL COLLATE NOCASE,
        display_name TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user', 'agent')),
        agent TEXT,
        role_id TEXT REFERENCES room_roles(id) ON DELETE SET NULL,
        worktree_id TEXT,
        pane_key TEXT,
        terminal_handle TEXT,
        provider_session_json TEXT,
        process_incarnation TEXT,
        state TEXT NOT NULL DEFAULT 'offline'
          CHECK(state IN ('starting', 'online', 'busy', 'offline', 'error')),
        context_json TEXT NOT NULL DEFAULT '{}',
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(room_id, identity)
      );
      INSERT INTO room_participants
        (id, room_id, identity, display_name, actor_kind, agent, role_id, worktree_id,
         pane_key, terminal_handle, provider_session_json, process_incarnation, state,
         context_json, last_seen_at, created_at, updated_at)
      SELECT * FROM room_participants_legacy;
      DROP TABLE room_participants_legacy;
    `)
    raw.close()

    const second = new RoomDatabase(path)
    const migrated = second.participants.update(agent.id, { state: 'sleeping' })
    expect(migrated.state).toBe('sleeping')
    expect(migrated.participation).toBe('active')
    expect(migrated.providerSession).toEqual({ key: 'session_id', id: 'session-1' })
    expect(migrated.terminalHandle).toBe('term-claude')
    expect(second.snapshot(snapshot.room.id, 'user').participants).toHaveLength(2)
    second.close()
  })

  it('persists active and paused participation independently from runtime state', () => {
    const database = memory()
    const snapshot = createRoom(database)
    const agent = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex'
    })
    expect(agent.participation).toBe('active')
    expect(database.participants.update(agent.id, { participation: 'paused' })).toMatchObject({
      participation: 'paused',
      state: 'offline'
    })
  })

  it('recovers an interrupted transactional delivery for retry after restart', () => {
    const database = memory()
    const snapshot = createRoom(database)
    const agent = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const delivery = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: '@claude inspect this',
      mentions: [agent.identity]
    }).deliveries[0]!

    expect(database.messages.deliveries.claim(delivery.id)?.state).toBe('delivering')
    database.messages.deliveries.recoverInterrupted(123)

    expect(database.messages.deliveries.get(delivery.id)).toMatchObject({
      state: 'pending',
      error: 'delivery_interrupted',
      nextAttemptAt: 123
    })
  })

  it('keeps only the latest five delivery attempt diagnostics', () => {
    const database = memory()
    const snapshot = createRoom(database)
    const agent = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const delivery = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: '@claude inspect this',
      mentions: [agent.identity]
    }).deliveries[0]!

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      database.messages.deliveries.claim(delivery.id)
      database.messages.deliveries.setPhase(delivery.id, 'submitting')
      database.messages.deliveries.complete(delivery.id, 'pending', `failure-${attempt}`, attempt)
    }

    expect(database.messages.deliveries.get(delivery.id).attemptHistory).toMatchObject([
      { attempt: 2, error: 'failure-2' },
      { attempt: 3, error: 'failure-3' },
      { attempt: 4, error: 'failure-4' },
      { attempt: 5, error: 'failure-5' },
      { attempt: 6, error: 'failure-6' }
    ])
  })

  it('creates a transactional outbox and suppresses agent loops at the room limit', () => {
    const database = memory()
    const snapshot = createRoom(database)
    database.core.update(snapshot.room.id, { loopLimit: 3 })
    const user = snapshot.participants[0]
    const alpha = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'alpha',
      displayName: 'Alpha',
      agent: 'claude'
    })
    const beta = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'beta',
      displayName: 'Beta',
      agent: 'codex'
    })
    const first = database.messages.create({
      roomId: snapshot.room.id,
      senderId: user.id,
      senderIdentity: user.identity,
      actorKind: 'user',
      body: '@alpha begin',
      mentions: ['alpha']
    })
    const second = database.messages.create({
      roomId: snapshot.room.id,
      senderId: alpha.id,
      senderIdentity: alpha.identity,
      actorKind: 'agent',
      body: '@beta challenge',
      mentions: ['beta'],
      replyToId: first.message.id
    })
    const third = database.messages.create({
      roomId: snapshot.room.id,
      senderId: beta.id,
      senderIdentity: beta.identity,
      actorKind: 'agent',
      body: '@alpha rebuttal',
      mentions: ['alpha'],
      replyToId: second.message.id
    })
    const guarded = database.messages.create({
      roomId: snapshot.room.id,
      senderId: alpha.id,
      senderIdentity: alpha.identity,
      actorKind: 'agent',
      body: '@beta another rebuttal',
      mentions: ['beta'],
      replyToId: third.message.id
    })

    expect(first.deliveries[0].state).toBe('pending')
    expect(second.message.hopCount).toBe(1)
    expect(third.message.hopCount).toBe(2)
    expect(guarded.message.hopCount).toBe(3)
    expect(guarded.deliveries[0].state).toBe('suppressed')
    expect(database.messages.list(snapshot.room.id, null, 20).deliveries).toContainEqual(
      expect.objectContaining({ messageId: guarded.message.id, state: 'suppressed' })
    )

    expect(database.messages.deliveries.retry(guarded.deliveries[0].id, 123)).toMatchObject({
      messageId: guarded.message.id,
      state: 'pending',
      nextAttemptAt: 123
    })
    const resumed = database.messages.create({
      roomId: snapshot.room.id,
      senderId: beta.id,
      senderIdentity: beta.identity,
      actorKind: 'agent',
      body: '@alpha continued response',
      mentions: ['alpha'],
      replyToId: guarded.message.id
    })
    expect(resumed.message.hopCount).toBe(4)
    expect(resumed.deliveries[0].state).toBe('pending')
  })

  it('paginates without rereading the whole room and tracks unread cursors', () => {
    const database = memory()
    const snapshot = createRoom(database)
    for (let index = 0; index < 7; index++) {
      database.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: 'egor',
        actorKind: 'user',
        body: `message ${index}`
      })
    }

    const newest = database.messages.list(snapshot.room.id, null, 3)
    const older = database.messages.list(snapshot.room.id, newest.beforeSequence, 3)
    expect(newest.messages.map((message) => message.body)).toEqual([
      'message 4',
      'message 5',
      'message 6'
    ])
    expect(older.messages.map((message) => message.body)).toEqual([
      'message 1',
      'message 2',
      'message 3'
    ])
    expect(newest.hasMore).toBe(true)
    expect(database.messages.getUnread(snapshot.room.id, 'egor').unreadCount).toBe(7)
    expect(
      database.messages.markRead(snapshot.room.id, 'egor', newest.messages[2].sequence).unreadCount
    ).toBe(0)
  })

  it('keeps pins in the room snapshot', () => {
    const database = memory()
    const snapshot = createRoom(database)
    const message = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'Pinned decision'
    }).message
    database.pins.set({
      roomId: snapshot.room.id,
      messageId: message.id,
      status: 'todo',
      createdBy: 'egor'
    })
    const updated = database.snapshot(snapshot.room.id, 'egor')
    expect(updated.pins).toMatchObject([{ messageId: message.id, status: 'todo' }])
  })

  it('lets each room customize or remove seeded roles', () => {
    const database = memory()
    const first = createRoom(database)
    const role = first.roles[0]
    expect(
      database.core.saveRole({
        id: role.id,
        roomId: first.room.id,
        name: 'Lead reviewer',
        prompt: 'Find the decisive issue.'
      })
    ).toMatchObject({ name: 'Lead reviewer', prompt: 'Find the decisive issue.' })
    database.core.deleteRole(role.id)
    expect(database.core.listRoles(first.room.id)).not.toContainEqual(
      expect.objectContaining({ id: role.id })
    )
  })

  it('renames participant references without rewriting provider session identity', () => {
    const database = memory()
    const snapshot = createRoom(database)
    const participant = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'provider-stable' }
    })
    const message = database.messages.create({
      roomId: snapshot.room.id,
      senderId: participant.id,
      senderIdentity: participant.identity,
      actorKind: 'agent',
      body: 'Result'
    }).message
    const renamed = database.participants.update(participant.id, { identity: 'codex-2' })

    expect(database.messages.get(message.id).senderIdentity).toBe('codex-2')
    expect(renamed.providerSession?.id).toBe('provider-stable')
  })

  it('rejects cross-room roles and parks archived room deliveries durably', () => {
    const database = memory()
    const first = createRoom(database)
    const second = database.createRoom({ projectId: 'project-1', name: 'Second' })
    const foreignRole = database.core.saveRole({
      roomId: second.room.id,
      name: 'External reviewer',
      prompt: 'Review'
    })
    const agent = database.participants.add({
      roomId: first.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    expect(() => database.participants.update(agent.id, { roleId: foreignRole.id })).toThrow(
      'room_role_not_found'
    )
    database.participants.update(agent.id, { paneKey: 'pane:claude' })
    expect(() =>
      database.participants.add({
        roomId: second.room.id,
        identity: 'claude',
        displayName: 'Claude',
        agent: 'claude',
        paneKey: 'pane:claude'
      })
    ).toThrow('room_agent_already_in_room')

    database.providerMessages.observeSnapshot(agent.id, 'session-1', ['old'])
    database.providerMessages.observeSnapshot(agent.id, 'session-1', ['old'])
    expect(database.providerMessages.hasObservedSession(agent.id, 'session-1')).toBe(true)
    database.providerMessages.resetStream(agent.id)
    expect(database.providerMessages.hasObservedSession(agent.id, 'session-1')).toBe(true)
    database.providerMessages.observeSnapshot(agent.id, 'session-1', ['old', 'archived'])

    const delivery = database.messages.create({
      roomId: first.room.id,
      senderId: first.participants[0].id,
      senderIdentity: first.participants[0].identity,
      actorKind: 'user',
      body: '@claude review',
      mentions: ['claude']
    }).deliveries[0]!
    expect(database.messages.deliveries.claim(delivery.id)?.state).toBe('delivering')
    database.core.update(first.room.id, { archived: true })
    expect(database.messages.deliveries.deferRoom(first.room.id)).toMatchObject([
      { id: delivery.id, state: 'failed', error: 'room_archived' }
    ])
    expect(database.messages.deliveries.complete(delivery.id, 'delivered', null)).toMatchObject({
      id: delivery.id,
      state: 'failed',
      error: 'room_archived'
    })
    database.core.update(first.room.id, { archived: false })
    expect(database.messages.deliveries.resumeRoom(first.room.id, 1)).toMatchObject([
      { id: delivery.id, state: 'pending', error: null, nextAttemptAt: 1 }
    ])
  })
})
