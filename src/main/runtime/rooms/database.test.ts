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

  it('never automatically retries a delivery that may have submitted Enter', () => {
    const database = memory()
    const snapshot = createRoom(database)
    const agent = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const deliveries = ['submitting', 'awaiting-turn'].map((phase) => {
      const delivery = database.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: 'egor',
        actorKind: 'user',
        body: phase
      }).deliveries[0]!
      database.messages.deliveries.claim(delivery.id)
      database.messages.deliveries.setPhase(delivery.id, phase as 'submitting' | 'awaiting-turn')
      return delivery
    })

    database.messages.deliveries.recoverInterrupted(123)

    expect(deliveries.map((item) => database.messages.deliveries.get(item.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'failed', error: 'room_delivery_uncertain' }),
        expect.objectContaining({ state: 'failed', error: 'room_delivery_uncertain' })
      ])
    )
    expect(database.messages.deliveries.listDue(123)).toEqual([])
    expect(agent.id).toBeTruthy()
  })

  it('selects one FIFO head per participant before applying the global limit', () => {
    const database = memory()
    const snapshot = createRoom(database)
    const alpha = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'alpha',
      displayName: 'Alpha',
      agent: 'codex'
    })
    const beta = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'beta',
      displayName: 'Beta',
      agent: 'claude'
    })
    const first = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'first'
    })
    const second = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'second'
    })
    const firstAlpha = first.deliveries.find((item) => item.participantId === alpha.id)!
    const secondAlpha = second.deliveries.find((item) => item.participantId === alpha.id)!
    const now = Date.now()
    database.messages.deliveries.claim(firstAlpha.id)
    database.messages.deliveries.complete(firstAlpha.id, 'pending', 'retry', now + 10_000)

    expect(
      database.messages.deliveries.listDue(now, 100).map((item) => item.participantId)
    ).toEqual([beta.id])
    expect(database.messages.deliveries.listDue(now + 10_000, 100)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstAlpha.id }),
        expect.objectContaining({ participantId: beta.id })
      ])
    )
    expect(database.messages.deliveries.listDue(500, 100)).not.toContainEqual(
      expect.objectContaining({ id: secondAlpha.id })
    )
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

    expect(database.messages.deliveries.resumeRoom(snapshot.room.id, 123)[0]).toMatchObject({
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

  it('stops every unresolved room delivery and resumes it as a new attempt', () => {
    const database = memory()
    const snapshot = createRoom(database)
    const alpha = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'alpha',
      displayName: 'Alpha',
      agent: 'codex'
    })
    const beta = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'beta',
      displayName: 'Beta',
      agent: 'claude'
    })
    const gamma = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'gamma',
      displayName: 'Gamma',
      agent: 'grok'
    })
    const created = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'Review this'
    })
    const alphaDelivery = created.deliveries.find(
      (delivery) => delivery.participantId === alpha.id
    )!
    const betaDelivery = created.deliveries.find((delivery) => delivery.participantId === beta.id)!
    const gammaDelivery = created.deliveries.find(
      (delivery) => delivery.participantId === gamma.id
    )!
    database.messages.deliveries.claim(alphaDelivery.id)
    database.messages.deliveries.setPhase(alphaDelivery.id, 'awaiting-turn')
    database.messages.deliveries.confirmTurn(alphaDelivery.id, 'turn-alpha')
    database.messages.deliveries.claim(betaDelivery.id)
    database.messages.deliveries.setPhase(betaDelivery.id, 'awaiting-turn')
    database.messages.deliveries.complete(
      betaDelivery.id,
      'failed',
      'room_delivery_uncertain',
      Number.MAX_SAFE_INTEGER
    )
    database.messages.deliveries.claim(gammaDelivery.id)
    database.messages.deliveries.setPhase(gammaDelivery.id, 'waking')
    database.messages.deliveries.complete(
      gammaDelivery.id,
      'suppressed',
      'room_participant_paused',
      Number.MAX_SAFE_INTEGER
    )

    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('active')
    const stopped = database.transaction(() =>
      database.messages.deliveries.stopRoom(snapshot.room.id)
    )
    expect(stopped.stopped).toHaveLength(2)
    expect(stopped.deliveries.every((delivery) => delivery.error === 'room_stopping')).toBe(true)
    expect(() => database.messages.deliveries.resumeRoom(snapshot.room.id, 456)).toThrow(
      'room_stop_in_progress'
    )
    database.messages.deliveries.finishRoomStop(stopped.deliveries.map((delivery) => delivery.id))
    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('stopped')
    expect(database.messages.deliveries.retry(alphaDelivery.id).state).toBe('suppressed')
    expect(database.messages.deliveries.get(gammaDelivery.id)).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused'
    })

    const resumed = database.transaction(() =>
      database.messages.deliveries.resumeRoom(snapshot.room.id, 456)
    )
    expect(resumed).toHaveLength(2)
    expect(
      resumed.every((delivery) => delivery.state === 'pending' && delivery.nextAttemptAt === 456)
    ).toBe(true)
    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('active')
    expect(database.messages.deliveries.get(gammaDelivery.id)).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused'
    })
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
      providerSession: { key: 'session_id', id: 'provider-stable' },
      paneKey: 'tab:codex',
      terminalHandle: 'term-codex'
    })
    const message = database.messages.create({
      roomId: snapshot.room.id,
      senderId: participant.id,
      senderIdentity: participant.identity,
      actorKind: 'agent',
      body: 'Result'
    }).message
    const mention = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: '@codex review',
      mentions: ['codex']
    }).message
    const renamed = database.participants.update(participant.id, {
      identity: 'Codex',
      displayName: 'Reviewer'
    })

    expect(database.messages.get(message.id).senderIdentity).toBe('Codex')
    expect(database.messages.get(mention.id).mentions).toEqual(['Codex'])
    expect(renamed.displayName).toBe('Reviewer')
    expect(renamed.paneKey).toBe('tab:codex')
    expect(renamed.terminalHandle).toBe('term-codex')
    expect(renamed.providerSession?.id).toBe('provider-stable')
  })

  it('rejects cross-room roles and duplicate live panes', () => {
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

    database.participants.update(agent.id, {
      worktreeId: 'worktree-1',
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    expect(() =>
      database.participants.add({
        roomId: second.room.id,
        identity: 'openclaude',
        displayName: 'OpenClaude',
        agent: 'openclaude',
        worktreeId: 'worktree-1',
        providerSession: { key: 'session_id', id: 'session-1' }
      })
    ).toThrow('room_agent_already_in_room')

    database.providerMessages.observeSnapshot(agent.id, 'session-1', ['old'])
    database.providerMessages.observeSnapshot(agent.id, 'session-1', ['old'])
    expect(database.providerMessages.hasObservedSession(agent.id, 'session-1')).toBe(true)
    database.providerMessages.resetStream(agent.id)
    expect(database.providerMessages.hasObservedSession(agent.id, 'session-1')).toBe(true)
  })

  it('deletes the complete room graph without touching another room', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-room-delete-'))
    directories.push(directory)
    const path = join(directory, 'rooms.db')
    const database = new RoomDatabase(path)
    databases.push(database)
    const deleted = createRoom(database)
    const kept = database.createRoom({ projectId: 'project-1', name: 'Kept' })
    const agent = database.participants.add({
      roomId: deleted.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    const created = database.messages.create({
      roomId: deleted.room.id,
      senderId: deleted.participants[0].id,
      senderIdentity: deleted.participants[0].identity,
      actorKind: 'user',
      body: '@codex review',
      mentions: ['codex'],
      attachments: [
        {
          id: crypto.randomUUID(),
          fileName: 'evidence.txt',
          mimeType: 'text/plain',
          byteSize: 1,
          localPath: join(directory, 'evidence.txt'),
          createdAt: 1
        }
      ]
    })
    const attachment = created.message.attachments[0]
    database.recordAttachmentDrop(attachment.id, 'ssh-1', '/repo/.orca/drops/evidence.txt')
    database.messages.markRead(deleted.room.id, 'user', created.message.sequence)
    database.pins.set({
      roomId: deleted.room.id,
      messageId: created.message.id,
      status: 'todo',
      createdBy: 'egor'
    })
    database.providerMessages.observeSnapshot(agent.id, 'session-1', ['provider-message'])
    database.activities.upsert({
      participantId: agent.id,
      identity: agent.identity,
      state: 'working',
      kind: 'command',
      detail: 'git status',
      messages: [],
      startedAt: 1,
      updatedAt: 1,
      anchorSequence: created.message.sequence
    })
    database.deliveryConfiguration.commit(agent.id, {
      providerSessionKey: 'session_id',
      providerSessionId: 'session-1',
      description: '',
      roleRevision: ''
    })

    database.deleteRoom({
      roomId: deleted.room.id,
      attachmentPaths: [attachment.localPath],
      pendingUploadIds: [],
      drops: database.listAttachmentDrops(deleted.room.id)
    })

    const raw = new SyncDatabase(path)
    const emptyQueries = [
      ['rooms', 'id', deleted.room.id],
      ['room_roles', 'room_id', deleted.room.id],
      ['room_participants', 'room_id', deleted.room.id],
      ['room_messages', 'room_id', deleted.room.id],
      ['room_reads', 'room_id', deleted.room.id],
      ['room_pins', 'room_id', deleted.room.id],
      ['room_attachment_drops', 'room_id', deleted.room.id],
      ['room_attachments', 'message_id', created.message.id],
      ['room_message_mentions', 'message_id', created.message.id],
      ['room_deliveries', 'message_id', created.message.id],
      ['room_provider_streams', 'participant_id', agent.id],
      ['room_provider_messages', 'participant_id', agent.id],
      ['room_agent_activity', 'participant_id', agent.id],
      ['room_delivery_configuration', 'participant_id', agent.id]
    ] as const
    for (const [table, column, value] of emptyQueries) {
      expect(raw.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value)).toBeUndefined()
    }
    expect(raw.prepare('SELECT 1 FROM rooms WHERE id = ?').get(kept.room.id)).toBeDefined()
    raw.close()
  })
})
