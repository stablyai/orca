import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDatabase } from './database'
import { claimReadyRoomDelivery } from './delivery-machine-readiness'
import type { RoomHarnessAdapter } from './harness-adapter'
import { claimReadyRoomBroadcast } from './delivery-broadcast-dispatch'

describe('room delivery claim readiness', () => {
  let database: RoomDatabase | undefined

  afterEach(() => database?.close())

  it('keeps a directed terminal delivery unclaimed while its agent is busy', async () => {
    database = new RoomDatabase(':memory:')
    const room = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const target = database.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:codex',
      terminalHandle: 'term-codex',
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    database.participants.add({
      roomId: room.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    database.participants.update(target.id, { state: 'busy' })
    const delivery = database.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'next',
      targetParticipantIds: [target.id]
    }).deliveries[0]

    const adapter = {
      status: vi.fn(async () => ({
        handle: 'term-codex',
        isRunningAgent: true,
        status: 'working' as const
      }))
    } as unknown as RoomHarnessAdapter
    const ensureReady = vi.fn()
    await expect(
      claimReadyRoomDelivery(database, { codex: adapter }, delivery, ensureReady, () => true)
    ).resolves.toBeNull()
    expect(ensureReady).not.toHaveBeenCalled()
    expect(database.messages.deliveries.get(delivery.id)).toMatchObject({
      state: 'pending',
      attempts: 0
    })
  })

  it('does not infer idle from an unknown live terminal status', async () => {
    database = new RoomDatabase(':memory:')
    const room = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const target = database.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:codex',
      terminalHandle: 'term-codex'
    })
    const delivery = database.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'next',
      targetParticipantIds: [target.id]
    }).deliveries[0]
    const adapter = {
      status: async () => ({ handle: 'term-codex', isRunningAgent: true, status: null })
    } as unknown as RoomHarnessAdapter

    const ensureReady = vi.fn()
    await expect(
      claimReadyRoomDelivery(database, { codex: adapter }, delivery, ensureReady, () => true)
    ).resolves.toBeNull()
    expect(ensureReady).not.toHaveBeenCalled()
  })

  it.each([
    { state: 'online' as const, dead: false },
    { state: 'busy' as const, dead: true }
  ])('recovers a stale $state binding before directed claim', async ({ state, dead }) => {
    database = new RoomDatabase(':memory:')
    const room = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const target = database.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old'
    })
    database.participants.add({
      roomId: room.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    database.participants.update(target.id, { state })
    const delivery = database.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'next',
      targetParticipantIds: [target.id]
    }).deliveries[0]
    let recovered = false
    const adapter = {
      status: vi.fn(async () => {
        if (!recovered) {
          if (!dead) {
            throw new Error('terminal_handle_stale')
          }
          return { handle: 'term-old', isRunningAgent: false, status: null }
        }
        return { handle: 'term-new', isRunningAgent: true, status: 'idle' as const }
      })
    } as unknown as RoomHarnessAdapter
    const gate = deferred()
    const ensureReady = vi.fn(async () => {
      await gate.promise
      recovered = true
      database!.participants.update(target.id, {
        state: 'online',
        terminalHandle: 'term-new',
        paneKey: 'tab:new'
      })
    })

    const ready = claimReadyRoomDelivery(
      database,
      { codex: adapter },
      delivery,
      ensureReady,
      () => true
    )
    await vi.waitFor(() => expect(ensureReady).toHaveBeenCalledWith(target.id))
    expect(database.messages.deliveries.get(delivery.id)).toMatchObject({
      state: 'pending',
      attempts: 0
    })
    gate.resolve()
    await expect(ready).resolves.toMatchObject({
      state: 'delivering',
      attempts: 1
    })
  })

  it('does not recover one broadcast target while another is physically working', async () => {
    database = new RoomDatabase(':memory:')
    const room = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const participants = (['codex', 'claude'] as const).map((identity) =>
      database!.participants.add({
        roomId: room.room.id,
        identity,
        displayName: identity,
        agent: identity,
        worktreeId: `worktree-${identity}`,
        paneKey: `tab:${identity}`,
        terminalHandle: `term-${identity}`
      })
    )
    const created = database.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'shared'
    })
    let recovered = false
    let siblingWorking = true
    const adapter = (identity: 'codex' | 'claude') =>
      ({
        status: vi.fn(async () => {
          if (identity === 'codex' && !recovered) {
            throw new Error('terminal_handle_stale')
          }
          return {
            handle: `term-${identity}`,
            isRunningAgent: true,
            status:
              identity === 'claude' && siblingWorking ? ('working' as const) : ('idle' as const)
          }
        })
      }) as unknown as RoomHarnessAdapter
    const ensureReady = vi.fn(async (id: string) => {
      expect(id).toBe(participants[0]!.id)
      recovered = true
    })

    await expect(
      claimReadyRoomBroadcast(
        database,
        { codex: adapter('codex'), claude: adapter('claude') },
        created.message.id,
        ensureReady,
        () => true
      )
    ).resolves.toBeNull()
    expect(ensureReady).not.toHaveBeenCalled()
    expect(created.deliveries.map(({ id }) => database!.messages.deliveries.get(id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'pending', attempts: 0 }),
        expect.objectContaining({ state: 'pending', attempts: 0 })
      ])
    )

    siblingWorking = false
    const claimed = await claimReadyRoomBroadcast(
      database,
      { codex: adapter('codex'), claude: adapter('claude') },
      created.message.id,
      ensureReady,
      () => true
    )
    expect(ensureReady).toHaveBeenCalledOnce()
    expect(claimed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'delivering', attempts: 1 }),
        expect.objectContaining({ state: 'delivering', attempts: 1 })
      ])
    )
  })

  it('abandons broadcast recovery when an active target is removed before phase two', async () => {
    database = new RoomDatabase(':memory:')
    const room = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const stale = database.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-codex',
      paneKey: 'tab:codex',
      terminalHandle: 'term-codex'
    })
    const removed = database.participants.add({
      roomId: room.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude',
      worktreeId: 'worktree-claude',
      paneKey: 'tab:claude',
      terminalHandle: 'term-claude'
    })
    const created = database.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'shared'
    })
    let recovered = false
    const adapter = (identity: 'codex' | 'claude') =>
      ({
        status: vi.fn(async () => {
          if (identity === 'codex' && !recovered) {
            throw new Error('terminal_handle_stale')
          }
          return { handle: identity, isRunningAgent: true, status: 'idle' as const }
        })
      }) as unknown as RoomHarnessAdapter

    await expect(
      claimReadyRoomBroadcast(
        database,
        { codex: adapter('codex'), claude: adapter('claude') },
        created.message.id,
        async (id) => {
          expect(id).toBe(stale.id)
          recovered = true
          database!.participants.remove(removed.id)
        },
        () => true
      )
    ).resolves.toBeNull()
    const remaining = created.deliveries.find(({ participantId }) => participantId === stale.id)!
    expect(database.messages.deliveries.get(remaining.id)).toMatchObject({
      state: 'pending',
      attempts: 0
    })
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
