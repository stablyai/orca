import { describe, expect, it, vi } from 'vitest'
import type { RoomAttachmentManager } from './attachments'
import { RoomDatabase } from './database'
import { RoomDeliveryWorker } from './delivery-worker'
import {
  createRoomHarnessAdapters,
  type RoomHarnessAdapter,
  type RoomHarnessRuntime
} from './harness-adapter'
import { claimReadyRoomBroadcast } from './delivery-broadcast-dispatch'

describe('room delivery claim races', () => {
  it('does not partially claim a message retargeted while readiness is pending', async () => {
    let releaseStatus = (): void => undefined
    let firstCodexProbe = true
    const blockedStatus = new Promise<void>((resolve) => (releaseStatus = resolve))
    const send = vi.fn(async (handle: string, prompt: string) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(prompt)
    }))
    const status = vi.fn(async (handle: string) => {
      if (handle === 'term-codex' && firstCodexProbe) {
        firstCodexProbe = false
        await blockedStatus
      }
      return {
        handle,
        isRunningAgent: true,
        status: handle === 'term-claude' ? ('working' as const) : ('idle' as const)
      }
    })
    const runtime = {
      ...runtimeStub(),
      sendTerminalAgentPrompt: send,
      getTerminalAgentStatus: status
    }
    const db = new RoomDatabase(':memory:')
    const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const participants = (['codex', 'claude'] as const).map((identity) =>
      db.participants.add({
        roomId: room.room.id,
        identity,
        displayName: identity,
        agent: identity,
        worktreeId: `worktree-${identity}`,
        paneKey: `tab:${identity}`,
        terminalHandle: `term-${identity}`,
        providerSession: { key: 'session_id', id: `session-${identity}` }
      })
    )
    const created = db.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'directed',
      targetParticipantIds: [participants[0]!.id]
    })
    const worker = new RoomDeliveryWorker(
      db,
      createRoomHarnessAdapters(runtime),
      { size: async () => 0 } as unknown as RoomAttachmentManager,
      () => {},
      async (id) => db.participants.get(id)
    )
    try {
      worker.start()
      await vi.waitFor(() => expect(status).toHaveBeenCalledWith('term-codex', expect.anything()))
      db.messages.deliveries.retarget(
        created.message.id,
        participants.map((participant) => participant.id)
      )
      worker.wake()
      releaseStatus()

      await vi.waitFor(() => expect(status).toHaveBeenCalledWith('term-claude', expect.anything()))
      expect(send).not.toHaveBeenCalled()
      expect(db.messages.deliveries.listForMessage(created.message.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'pending', attempts: 0 }),
          expect.objectContaining({ state: 'pending', attempts: 0 })
        ])
      )
    } finally {
      worker.dispose()
      db.close()
    }
  })

  it('rejects a shared claim when a ready participant becomes busy', async () => {
    const race = broadcastReadinessRace()
    try {
      await race.firstReady.promise
      race.db.participants.update(race.firstParticipantId, { state: 'busy' })
      race.releaseSecond.resolve()

      await expect(race.claiming).resolves.toBeNull()
      expect(race.deliveries()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'pending', attempts: 0 }),
          expect.objectContaining({ state: 'pending', attempts: 0 })
        ])
      )
    } finally {
      race.releaseSecond.resolve()
      race.db.close()
    }
  })

  it('rejects a shared claim when readiness binding evidence changes', async () => {
    const race = broadcastReadinessRace()
    try {
      await race.firstReady.promise
      race.db.participants.update(race.firstParticipantId, {
        terminalHandle: 'term-codex-rebound',
        paneKey: 'tab:codex-rebound',
        providerSession: { key: 'session_id', id: 'session-codex-rebound' }
      })
      race.releaseSecond.resolve()

      await expect(race.claiming).resolves.toBeNull()
      expect(race.deliveries()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'pending', attempts: 0 }),
          expect.objectContaining({ state: 'pending', attempts: 0 })
        ])
      )
    } finally {
      race.releaseSecond.resolve()
      race.db.close()
    }
  })

  it('rejects a shared claim when process incarnation changes', async () => {
    const race = broadcastReadinessRace()
    try {
      await race.firstReady.promise
      race.db.participants.update(race.firstParticipantId, {
        processIncarnation: 'pty:rebound'
      })
      race.releaseSecond.resolve()

      await expect(race.claiming).resolves.toBeNull()
      expect(race.deliveries()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'pending', attempts: 0 }),
          expect.objectContaining({ state: 'pending', attempts: 0 })
        ])
      )
    } finally {
      race.releaseSecond.resolve()
      race.db.close()
    }
  })
})

function broadcastReadinessRace(): {
  db: RoomDatabase
  firstParticipantId: string
  firstReady: ReturnType<typeof deferred>
  releaseSecond: ReturnType<typeof deferred>
  claiming: Promise<ReturnType<RoomDatabase['messages']['deliveries']['claimBroadcast']>>
  deliveries: () => ReturnType<RoomDatabase['messages']['deliveries']['listForMessage']>
} {
  const db = new RoomDatabase(':memory:')
  const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
  const participants = (['codex', 'claude'] as const).map((identity) =>
    db.participants.add({
      roomId: room.room.id,
      identity,
      displayName: identity,
      agent: identity,
      worktreeId: `worktree-${identity}`,
      paneKey: `tab:${identity}`,
      terminalHandle: `term-${identity}`,
      providerSession: { key: 'session_id', id: `session-${identity}` },
      processIncarnation: `pty:${identity}`
    })
  )
  const created = db.messages.create({
    roomId: room.room.id,
    senderId: room.participants[0].id,
    senderIdentity: room.participants[0].identity,
    actorKind: 'user',
    body: 'shared'
  })
  const firstReady = deferred()
  const releaseSecond = deferred()
  const adapter = (status: () => Promise<void>): RoomHarnessAdapter =>
    ({
      status: async () => {
        await status()
        return { handle: 'terminal', isRunningAgent: true, status: 'idle' }
      }
    }) as unknown as RoomHarnessAdapter
  const claiming = claimReadyRoomBroadcast(
    db,
    {
      codex: adapter(async () => firstReady.resolve()),
      claude: adapter(async () => releaseSecond.promise)
    },
    created.message.id,
    async (id) => db.participants.get(id),
    () => true
  )
  return {
    db,
    firstParticipantId: participants[0]!.id,
    firstReady,
    releaseSecond,
    claiming,
    deliveries: () => db.messages.deliveries.listForMessage(created.message.id)
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function runtimeStub(): RoomHarnessRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('unused')
  }
  return {
    createAgentSession: unused,
    ensureAgentSession: unused,
    sendTerminalAgentPrompt: unused,
    waitForTerminalAgentInputReady: unused,
    compactTerminalAgentSession: unused,
    getTerminalAgentStatus: unused,
    getTerminalProcessIncarnation: () => null,
    closeTerminal: unused,
    waitForTerminal: unused,
    listRoomRunningAgents: async () => [],
    listRoomExistingAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: async (_worktreeId, _handle, attachment) => attachment.localPath
  }
}
