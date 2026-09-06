import { expect, it, vi } from 'vitest'
import type { RuntimeEnsureAgentSessionResult } from '../../../shared/agent-session-host-authority'
import type { RoomEvent } from '../../../shared/rooms'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import { RoomDatabase } from './database'
import { createRoomHarnessAdapters, type RoomHarnessRuntime } from './harness-adapter'
import type { RoomAttachmentManager } from './attachments'
import { RoomDeliveryWorker } from './delivery-worker'
import { RoomService } from './service'

function runtime(): RoomHarnessRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('unused')
  }
  return {
    createAgentSession: unused,
    ensureAgentSession: unused,
    sendTerminalAgentPrompt: unused,
    waitForTerminalAgentInputReady: async () => true,
    compactTerminalAgentSession: unused,
    getTerminalAgentStatus: unused,
    getTerminalProcessIncarnation: () => null,
    closeTerminal: unused,
    waitForTerminal: unused,
    listRoomRunningAgents: async () => [],
    listRoomExistingAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: unused
  }
}

it('serializes participant removal with restore ownership transfer', async () => {
  const harness = runtime()
  let finishRestore!: (result: RuntimeEnsureAgentSessionResult) => void
  harness.ensureAgentSession = vi.fn(
    () => new Promise<RuntimeEnsureAgentSessionResult>((resolve) => (finishRestore = resolve))
  )
  let finishStop!: () => void
  harness.closeTerminal = vi.fn(
    (handle) =>
      new Promise<RuntimeTerminalClose>((resolve) => {
        finishStop = () => resolve({ handle, tabId: 'tab:restored', ptyKilled: true })
      })
  )
  harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
    handle,
    isRunningAgent: true,
    status: 'idle' as const
  }))
  const service = new RoomService(':memory:', harness)
  const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
  const participant = service.db.participants.add({
    roomId: room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex',
    worktreeId: 'worktree-1',
    paneKey: 'tab:stale',
    terminalHandle: 'term-stale',
    providerSession: { key: 'session_id', id: 'session-1' }
  })
  service.db.providerMessages.observeSnapshot(participant.id, 'session-1', [])

  try {
    const restoring = service.participantController.restore(participant)
    const removal = service.removeParticipant(participant.id)
    expect(service.removeParticipant(participant.id)).toBe(removal)
    await vi.waitFor(() => expect(harness.ensureAgentSession).toHaveBeenCalledOnce())

    finishRestore({
      terminal: {
        handle: 'term-restored',
        paneKey: 'tab:restored',
        worktreeId: 'worktree-1',
        title: null
      },
      disposition: 'created'
    })
    await restoring
    await vi.waitFor(() =>
      expect(harness.closeTerminal).toHaveBeenCalledWith('term-restored', {
        force: true,
        waitForExit: true
      })
    )

    const lateRestore = service.participantController.restore(participant)
    await Promise.resolve()
    expect(harness.ensureAgentSession).toHaveBeenCalledOnce()
    finishStop()

    await removal
    await expect(lateRestore).rejects.toThrow('room_participant_not_found')
    expect(harness.closeTerminal).toHaveBeenCalledOnce()
    expect(() => service.db.participants.get(participant.id)).toThrow('room_participant_not_found')
  } finally {
    service.close()
  }
})

it('settles an in-flight delivery removed by participant cascade', async () => {
  const harness = runtime()
  harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
    handle,
    isRunningAgent: true,
    status: 'idle' as const
  }))
  let finishStage!: () => void
  harness.stageRoomAttachment = vi.fn(
    (_worktreeId, _terminalHandle, attachment) =>
      new Promise<string>((resolve) => {
        finishStage = () => resolve(attachment.localPath)
      })
  )
  harness.sendTerminalAgentPrompt = vi.fn(async (handle, prompt) => ({
    handle,
    accepted: true,
    bytesWritten: Buffer.byteLength(prompt)
  }))
  const db = new RoomDatabase(':memory:')
  const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
  const participant = db.participants.add({
    roomId: room.room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex',
    worktreeId: 'worktree-1',
    paneKey: 'tab:codex',
    terminalHandle: 'term-codex'
  })
  const delivery = db.messages.create({
    roomId: room.room.id,
    senderId: room.participants[0].id,
    senderIdentity: room.participants[0].identity,
    actorKind: 'user',
    body: 'read this',
    targetParticipantIds: [participant.id],
    attachments: [
      {
        id: 'attachment-1',
        fileName: 'report.txt',
        mimeType: 'text/plain',
        byteSize: 4,
        localPath: '/stored/report.txt'
      }
    ]
  }).deliveries[0]
  const events: RoomEvent[] = []
  const worker = new RoomDeliveryWorker(
    db,
    createRoomHarnessAdapters(harness),
    { size: async () => 4 } as unknown as RoomAttachmentManager,
    (_roomId, event) => events.push(event),
    async (id) => db.participants.get(id)
  )

  try {
    worker.start()
    await vi.waitFor(() => expect(harness.stageRoomAttachment).toHaveBeenCalledOnce())
    db.participants.remove(participant.id)
    const eventCount = events.length
    finishStage()
    const fence = worker.requestRoomFence(room.room.id, { discardConfirmations: false })
    await fence.ready
    fence.release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(() => db.messages.deliveries.get(delivery.id)).toThrow('room_delivery_not_found')
    expect(harness.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(events).toHaveLength(eventCount)
  } finally {
    worker.dispose()
    db.close()
  }
})

it('keeps Retry fenced when participant removal races room Stop', async () => {
  const harness = runtime()
  const events: RoomEvent[] = []
  harness.emitRoomEvent = (_roomId, event) => events.push(event)
  harness.sendTerminal = vi.fn(async (handle, action) => ({
    handle,
    accepted: true,
    bytesWritten: Buffer.byteLength(action.text ?? '')
  }))
  let finishWait!: () => void
  harness.waitForTerminal = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<RoomHarnessRuntime['waitForTerminal']>>>((resolve) => {
        finishWait = () =>
          resolve({
            handle: 'term-alpha',
            condition: 'tui-idle',
            satisfied: true,
            status: 'running',
            exitCode: null
          })
      })
  )
  harness.closeTerminal = vi.fn(async (handle) => ({
    handle,
    tabId: 'pane-alpha',
    ptyKilled: true
  }))
  const service = new RoomService(':memory:', harness)
  const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
  const alpha = service.db.participants.add({
    roomId: snapshot.room.id,
    identity: 'alpha',
    displayName: 'Alpha',
    agent: 'codex',
    worktreeId: 'worktree-1',
    paneKey: 'pane-alpha',
    terminalHandle: 'term-alpha'
  })
  const beta = service.db.participants.add({
    roomId: snapshot.room.id,
    identity: 'beta',
    displayName: 'Beta',
    agent: 'claude'
  })
  const create = (body: string, participantId: string) =>
    service.db.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body,
      targetParticipantIds: [participantId]
    }).deliveries[0]
  const failed = create('Retry later', beta.id)
  service.db.messages.deliveries.claim(failed.id)
  service.db.messages.deliveries.complete(
    failed.id,
    'failed',
    'temporary_failure',
    Number.MAX_SAFE_INTEGER
  )
  const stopping = create('Stop this', alpha.id)
  service.db.messages.deliveries.claim(stopping.id)
  service.db.messages.deliveries.setPhase(stopping.id, 'awaiting-turn')

  try {
    const stop = service.stopRoom(snapshot.room.id)
    await vi.waitFor(() => expect(harness.sendTerminal).toHaveBeenCalledOnce())
    service.retryDelivery(failed.id)
    await service.removeParticipant(alpha.id)
    finishWait()

    await expect(stop).resolves.toBe(1)
    expect(
      events
        .filter((event) => event.type === 'delivery.updated')
        .every((event) => Boolean(event.delivery))
    ).toBe(true)
    expect(service.snapshot(snapshot.room.id).workState).toBe('stopped')
    expect(service.db.messages.deliveries.listDue()).toEqual([])

    await expect(service.resumeRoom(snapshot.room.id)).resolves.toBe(0)
    expect(service.db.messages.deliveries.listDue().map(({ id }) => id)).toContain(failed.id)
    expect(events.at(-1)).toMatchObject({ type: 'room.updated', workState: 'active' })
  } finally {
    service.close()
  }
})
