import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomHarnessAgent } from '../../../shared/rooms'
import { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import { claimRoomSteer, runRoomSteer } from './delivery-steer-selection'

describe('room Steer selection', () => {
  let database: RoomDatabase | undefined

  afterEach(() => database?.close())

  const setup = () => {
    database = new RoomDatabase(':memory:')
    return { database, snapshot: database.createRoom({ projectId: 'project', name: 'room' }) }
  }

  const addMachine = (
    db: RoomDatabase,
    roomId: string,
    identity: string,
    agent: RoomHarnessAgent
  ) =>
    db.participants.add({
      roomId,
      identity,
      displayName: identity,
      agent,
      worktreeId: `worktree-${identity}`,
      providerSession: {
        key: 'session_id',
        id: `session-${identity}`,
        transport: 'machine'
      }
    })

  const create = (
    db: RoomDatabase,
    snapshot: ReturnType<RoomDatabase['createRoom']>,
    targetParticipantIds?: string[]
  ) =>
    db.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'queued',
      targetParticipantIds
    })

  const adapter = (getStatus: () => Promise<'idle' | 'working'>): RoomHarnessAdapter =>
    ({
      steer: vi.fn(),
      status: vi.fn(async () => ({
        handle: 'machine',
        isRunningAgent: true,
        status: await getStatus()
      }))
    }) as unknown as RoomHarnessAdapter

  it('keeps markerless directed Steer scoped to its exact delivery', async () => {
    const { database, snapshot } = setup()
    const codex = addMachine(database, snapshot.room.id, 'codex', 'codex')
    addMachine(database, snapshot.room.id, 'claude', 'claude')
    const created = create(database, snapshot, [codex.id])
    const selected = created.deliveries.find((delivery) => delivery.participantId === codex.id)!

    const claimed = await claimRoomSteer(
      database,
      { codex: adapter(async () => 'working') },
      selected.id,
      false
    )

    expect(claimed.deliveries).toEqual([
      expect.objectContaining({ id: selected.id, state: 'delivering', intent: 'steer' })
    ])
  })

  it('rejects another Steer while the target already has one submitting', async () => {
    const { database, snapshot } = setup()
    const codex = addMachine(database, snapshot.room.id, 'codex', 'codex')
    addMachine(database, snapshot.room.id, 'claude', 'claude')
    const first = create(database, snapshot, [codex.id]).deliveries.find(
      (delivery) => delivery.participantId === codex.id
    )!
    database.messages.deliveries.claimSteer(first.id)
    const second = create(database, snapshot, [codex.id]).deliveries.find(
      (delivery) => delivery.participantId === codex.id
    )!
    const release = vi.fn()
    const requestFence = vi.fn(() => ({
      ready: Promise.resolve(),
      claimAllowed: () => true,
      release
    }))

    await expect(
      runRoomSteer(
        database,
        { codex: adapter(async () => 'working') },
        second.id,
        requestFence,
        vi.fn(),
        vi.fn(),
        false
      )
    ).rejects.toThrow('conversation_steer_busy')
    expect(requestFence).toHaveBeenCalledWith(snapshot.room.id, {
      discardConfirmations: false,
      waitForTasks: false
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects markerless Steer for a broadcast before probing agents', async () => {
    const { database, snapshot } = setup()
    const codex = addMachine(database, snapshot.room.id, 'codex', 'codex')
    const claude = addMachine(database, snapshot.room.id, 'claude', 'claude')
    const created = create(database, snapshot)
    const selected = created.deliveries.find((delivery) => delivery.participantId === codex.id)!
    const codexStatus = vi.fn(async () => 'working' as const)
    const claudeStatus = vi.fn(async () => 'idle' as const)

    await expect(
      claimRoomSteer(
        database,
        { codex: adapter(codexStatus), claude: adapter(claudeStatus) },
        selected.id,
        false
      )
    ).rejects.toThrow('room_delivery_queue_stale')
    expect(codexStatus).not.toHaveBeenCalled()
    expect(claudeStatus).not.toHaveBeenCalled()
    expect(database.messages.deliveries.listForMessage(created.message.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: codex.id, state: 'pending', attempts: 0 }),
        expect.objectContaining({ participantId: claude.id, state: 'pending', attempts: 0 })
      ])
    )
  })

  it('rejects broadcast Steer when an active participant is not machine-bound', async () => {
    const { database, snapshot } = setup()
    const machine = addMachine(database, snapshot.room.id, 'machine', 'codex')
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'terminal',
      displayName: 'terminal',
      agent: 'claude',
      worktreeId: 'worktree-terminal',
      terminalHandle: 'terminal-handle',
      paneKey: 'terminal-pane'
    })
    const created = create(database, snapshot)
    const selected = created.deliveries.find((delivery) => delivery.participantId === machine.id)!

    await expect(
      claimRoomSteer(database, { codex: adapter(async () => 'working') }, selected.id, true)
    ).rejects.toThrow('conversation_steer_unsupported')
    expect(database.messages.deliveries.listForMessage(created.message.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'pending', intent: 'next', attempts: 0 }),
        expect.objectContaining({ state: 'pending', intent: 'next', attempts: 0 })
      ])
    )
  })

  it('rejects an explicit group marker for a directed message', async () => {
    const { database, snapshot } = setup()
    const codex = addMachine(database, snapshot.room.id, 'codex', 'codex')
    addMachine(database, snapshot.room.id, 'claude', 'claude')
    const created = create(database, snapshot, [codex.id])

    await expect(claimRoomSteer(database, {}, created.deliveries[0]!.id, true)).rejects.toThrow(
      'room_delivery_queue_stale'
    )
  })

  it('rejects group reservation when the active set changes during status probing', async () => {
    const { database, snapshot } = setup()
    const codex = addMachine(database, snapshot.room.id, 'codex', 'codex')
    addMachine(database, snapshot.room.id, 'claude', 'claude')
    const created = create(database, snapshot)
    const selected = created.deliveries.find((delivery) => delivery.participantId === codex.id)!
    const gate = deferred()
    const statusStarted = deferred()
    const blocked = adapter(async () => {
      statusStarted.resolve()
      await gate.promise
      return 'working'
    })
    const steering = claimRoomSteer(
      database,
      { codex: blocked, claude: blocked },
      selected.id,
      true
    )
    await statusStarted.promise
    addMachine(database, snapshot.room.id, 'grok', 'grok')
    gate.resolve()

    await expect(steering).rejects.toThrow('room_delivery_queue_stale')
    expect(created.deliveries.map(({ id }) => database.messages.deliveries.get(id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'pending', attempts: 0 }),
        expect.objectContaining({ state: 'pending', attempts: 0 })
      ])
    )
  })

  it('rejects group reservation when a validated machine binding changes', async () => {
    const { database, snapshot } = setup()
    const codex = addMachine(database, snapshot.room.id, 'codex', 'codex')
    const claude = addMachine(database, snapshot.room.id, 'claude', 'claude')
    const created = create(database, snapshot)
    const selected = created.deliveries.find((delivery) => delivery.participantId === codex.id)!
    const gate = deferred()
    const statusStarted = deferred()
    const blocked = adapter(async () => {
      statusStarted.resolve()
      await gate.promise
      return 'working'
    })
    const steering = claimRoomSteer(
      database,
      { codex: blocked, claude: blocked },
      selected.id,
      true
    )
    await statusStarted.promise
    database.participants.update(claude.id, {
      terminalHandle: 'term-claude',
      paneKey: 'pane-claude',
      providerSession: { key: 'session_id', id: 'session-claude' }
    })
    gate.resolve()

    await expect(steering).rejects.toThrow('room_delivery_queue_stale')
    expect(created.deliveries.map(({ id }) => database.messages.deliveries.get(id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'pending', attempts: 0 }),
        expect.objectContaining({ state: 'pending', attempts: 0 })
      ])
    )
  })

  it('does not partially claim a directed message retargeted during status probing', async () => {
    const { database, snapshot } = setup()
    const codex = addMachine(database, snapshot.room.id, 'codex', 'codex')
    const claude = addMachine(database, snapshot.room.id, 'claude', 'claude')
    const created = create(database, snapshot, [codex.id])
    const selected = created.deliveries.find((delivery) => delivery.participantId === codex.id)!
    const gate = deferred()
    const statusStarted = deferred()
    const steering = claimRoomSteer(
      database,
      {
        codex: adapter(async () => {
          statusStarted.resolve()
          await gate.promise
          return 'working'
        })
      },
      selected.id,
      false
    )
    await statusStarted.promise
    database.messages.deliveries.retarget(created.message.id, [codex.id, claude.id])
    gate.resolve()

    await expect(steering).rejects.toThrow('room_delivery_queue_stale')
    expect(database.messages.deliveries.listForMessage(created.message.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'pending', attempts: 0 }),
        expect.objectContaining({ state: 'pending', attempts: 0 })
      ])
    )
  })

  it('does not claim directed Steer after its machine binding changes', async () => {
    const { database, snapshot } = setup()
    const codex = addMachine(database, snapshot.room.id, 'codex', 'codex')
    addMachine(database, snapshot.room.id, 'claude', 'claude')
    const created = create(database, snapshot, [codex.id])
    const selected = created.deliveries.find((delivery) => delivery.participantId === codex.id)!
    const gate = deferred()
    const statusStarted = deferred()
    const steering = claimRoomSteer(
      database,
      {
        codex: adapter(async () => {
          statusStarted.resolve()
          await gate.promise
          return 'working'
        })
      },
      selected.id,
      false
    )
    await statusStarted.promise
    database.participants.update(codex.id, {
      worktreeId: 'worktree-rebound',
      providerSession: {
        key: 'session_id',
        id: 'session-rebound',
        transport: 'machine'
      }
    })
    gate.resolve()

    await expect(steering).rejects.toThrow('room_delivery_queue_stale')
    expect(database.messages.deliveries.get(selected.id)).toMatchObject({
      state: 'pending',
      intent: 'next',
      attempts: 0
    })
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
