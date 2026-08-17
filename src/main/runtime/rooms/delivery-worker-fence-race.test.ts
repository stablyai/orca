import { expect, it, vi } from 'vitest'
import type { RoomAttachmentManager } from './attachments'
import { RoomDatabase } from './database'
import { createRoomHarnessAdapters, type RoomHarnessRuntime } from './harness-adapter'
import { RoomDeliveryWorker } from './delivery-worker'

it.each([{ broadcast: false }, { broadcast: true }])(
  'prevents a late readiness claim after a room fence (broadcast=$broadcast)',
  async ({ broadcast }) => {
    const statusStarted = deferred()
    const releaseStatus = deferred()
    const send = vi.fn(async (handle: string, prompt: string) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(prompt)
    }))
    const runtime = {
      ...runtimeStub(),
      sendTerminalAgentPrompt: send,
      getTerminalAgentStatus: vi.fn(async (handle: string) => {
        if (handle === 'term-codex') {
          statusStarted.resolve()
          await releaseStatus.promise
        }
        return { handle, isRunningAgent: true, status: 'idle' as const }
      })
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
        terminalHandle: `term-${identity}`
      })
    )
    const created = db.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'queued',
      ...(broadcast ? {} : { targetParticipantIds: [participants[0]!.id] })
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
      await statusStarted.promise
      const fence = worker.requestRoomFence(room.room.id, { discardConfirmations: false })
      releaseStatus.resolve()
      await fence.ready

      expect(send).not.toHaveBeenCalled()
      expect(created.deliveries.map(({ id }) => db.messages.deliveries.get(id))).toEqual(
        created.deliveries.map(({ id }) =>
          expect.objectContaining({ id, state: 'pending', attempts: 0 })
        )
      )
      fence.release()
    } finally {
      releaseStatus.resolve()
      worker.dispose()
      db.close()
    }
  }
)

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
