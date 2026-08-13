import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnsureAgentSessionResult } from '../../../shared/agent-session-host-authority'
import type { RoomEvent } from '../../../shared/rooms'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import type { RoomHarnessRuntime } from './harness-adapter'
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

describe('room deletion', () => {
  it('keeps the room when a participant process stop is unconfirmed', async () => {
    const harness = runtime()
    harness.closeTerminal = vi.fn(async (handle) => ({
      handle,
      tabId: 'pane-live',
      ptyKilled: false
    }))
    harness.listRoomRunningAgents = vi.fn(async () => [
      {
        agent: 'codex' as const,
        worktreeId: 'worktree-1',
        terminalHandle: 'term-live',
        paneKey: 'pane-live',
        title: 'Codex',
        providerSession: { key: 'session_id' as const, id: 'session-live' }
      }
    ])
    const service = new RoomService(':memory:', harness)
    try {
      const snapshot = service.createRoom({ projectId: 'project-1', name: 'Keep me' })
      service.db.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'pane-live',
        terminalHandle: 'term-live',
        providerSession: { key: 'session_id', id: 'session-live' }
      })

      await expect(service.deleteRoom(snapshot.room.id)).rejects.toThrow(
        'room_agent_stop_unconfirmed'
      )
      expect(service.db.core.get(snapshot.room.id)).toBeDefined()
    } finally {
      service.close()
    }
  })

  it('waits for an in-flight delivery and rejects new room work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-delete-delivery-'))
    const harness = runtime()
    let finishSend!: (result: { handle: string; accepted: true; bytesWritten: number }) => void
    harness.sendTerminalAgentPrompt = vi.fn(
      (handle) =>
        new Promise<RuntimeTerminalSend>((resolve) => {
          finishSend = resolve
          expect(handle).toBe('term-codex')
        })
    )
    harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    harness.closeTerminal = vi.fn(async (handle) => ({
      handle,
      tabId: 'tab:codex',
      ptyKilled: true
    }))
    const service = new RoomService(join(root, 'rooms.db'), harness)
    try {
      const snapshot = service.createRoom({ projectId: 'project-1', name: 'Delete me' })
      service.db.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:codex',
        terminalHandle: 'term-codex'
      })
      await service.sendMessage({
        roomId: snapshot.room.id,
        senderIdentity: snapshot.participants[0].identity,
        body: '@codex review',
        mentions: ['codex']
      })
      await vi.waitFor(() => expect(harness.sendTerminalAgentPrompt).toHaveBeenCalledOnce())

      const deletion = service.deleteRoom(snapshot.room.id)
      expect(() =>
        service.sendMessage({
          roomId: snapshot.room.id,
          senderIdentity: snapshot.participants[0].identity,
          body: 'late message'
        })
      ).toThrow('room_deleting')
      expect(service.db.core.get(snapshot.room.id)).toBeDefined()

      finishSend({ handle: 'term-codex', accepted: true, bytesWritten: 1 })
      await deletion
      expect(() => service.db.core.get(snapshot.room.id)).toThrow('room_not_found')
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('quiesces once and removes room files before completing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-delete-'))
    const harness = runtime()
    harness.closeTerminal = vi.fn(async (handle) => ({
      handle,
      tabId: 'tab:codex',
      ptyKilled: true
    }))
    harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    harness.cleanupDeletedRoomResources = vi.fn(async () => undefined)
    const service = new RoomService(join(root, 'rooms.db'), harness)
    try {
      const snapshot = service.createRoom({ projectId: 'project-1', name: 'Delete me' })
      const participant = service.db.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:codex',
        terminalHandle: 'term-codex'
      })
      const upload = await service.startAttachmentUpload(snapshot.room.id, 'evidence.txt', 4)
      await service.attachmentTransfers.appendUpload(
        upload.uploadId,
        0,
        Buffer.from('data').toString('base64')
      )
      service.attachmentTransfers.finishUpload(upload.uploadId)
      const message = await service.sendMessage({
        roomId: snapshot.room.id,
        senderIdentity: snapshot.participants[0].identity,
        body: '',
        attachmentUploadIds: [upload.uploadId]
      })
      const pending = await service.startAttachmentUpload(snapshot.room.id, 'pending.txt', 4)
      const attachmentPath = message.attachments[0].localPath
      const pendingPath = join(root, 'room-attachments', '.uploads', `${pending.uploadId}.part`)
      const kept = service.createRoom({ projectId: 'project-1', name: 'Keep me' })
      const keptUpload = await service.startAttachmentUpload(kept.room.id, 'kept.txt', 4)
      await service.attachmentTransfers.appendUpload(
        keptUpload.uploadId,
        0,
        Buffer.from('keep').toString('base64')
      )
      service.attachmentTransfers.finishUpload(keptUpload.uploadId)
      const keptMessage = await service.sendMessage({
        roomId: kept.room.id,
        senderIdentity: kept.participants[0].identity,
        body: '',
        attachmentUploadIds: [keptUpload.uploadId]
      })
      const keptPending = await service.startAttachmentUpload(kept.room.id, 'pending.txt', 1)
      const keptPendingPath = join(
        root,
        'room-attachments',
        '.uploads',
        `${keptPending.uploadId}.part`
      )
      const events: RoomEvent[] = []
      service.subscribe(snapshot.room.id, 'user', (event) => events.push(event))

      const first = service.deleteRoom(snapshot.room.id)
      expect(service.deleteRoom(snapshot.room.id)).toBe(first)
      await first

      expect(harness.closeTerminal).toHaveBeenCalledOnce()
      expect(harness.closeTerminal).toHaveBeenCalledWith('term-codex', {
        force: true,
        waitForExit: true
      })
      expect(harness.cleanupDeletedRoomResources).toHaveBeenCalledOnce()
      expect(() => service.snapshot(snapshot.room.id)).toThrow('room_not_found')
      await expect(access(attachmentPath)).rejects.toThrow()
      await expect(access(pendingPath)).rejects.toThrow()
      await expect(access(keptMessage.attachments[0].localPath)).resolves.toBeUndefined()
      await expect(access(keptPendingPath)).resolves.toBeUndefined()
      expect(roomGenerationIds(service.attachmentTransfers)).not.toContain(snapshot.room.id)
      expect(roomGenerationIds(service.archiveTransfers)).not.toContain(snapshot.room.id)
      expect(transcriptGenerationIds(service)).not.toContain(participant.id)
      expect(events.at(-1)).toEqual({ type: 'end', reason: 'deleted' })
      const eventCount = events.length
      service.emitEvent(snapshot.room.id, { type: 'end' })
      expect(events).toHaveLength(eventCount)
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('waits for an active restore and stops its restored PTY before deleting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-delete-restore-'))
    const harness = runtime()
    let finishEnsure!: (result: RuntimeEnsureAgentSessionResult) => void
    harness.ensureAgentSession = vi.fn(
      () => new Promise<RuntimeEnsureAgentSessionResult>((resolve) => (finishEnsure = resolve))
    )
    harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    harness.closeTerminal = vi.fn(async (handle) => ({
      handle,
      tabId: 'tab:restored',
      ptyKilled: true
    }))
    const service = new RoomService(join(root, 'rooms.db'), harness)
    try {
      const snapshot = service.createRoom({ projectId: 'project-1', name: 'Delete me' })
      const participant = service.db.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:stale',
        terminalHandle: 'term-stale',
        providerSession: { key: 'session_id', id: 'session-1' }
      })
      service.db.providerMessages.observeSnapshot(participant.id, 'session-1', [])
      const restore = service.participantController.restore(participant)
      await vi.waitFor(() => expect(harness.ensureAgentSession).toHaveBeenCalledOnce())

      const deletion = service.deleteRoom(snapshot.room.id)
      expect(service.db.core.get(snapshot.room.id)).toBeDefined()
      finishEnsure({
        terminal: {
          handle: 'term-restored',
          paneKey: 'tab:restored',
          worktreeId: 'worktree-1',
          title: null
        },
        disposition: 'adopted'
      })

      await restore
      await deletion
      expect(harness.closeTerminal).toHaveBeenCalledWith('term-restored', {
        force: true,
        waitForExit: true
      })
      expect(() => service.db.participants.get(participant.id)).toThrow(
        'room_participant_not_found'
      )
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('waits for upload creation before deleting its pending file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-delete-upload-'))
    const service = new RoomService(join(root, 'rooms.db'), runtime())
    try {
      const snapshot = service.createRoom({ projectId: 'project-1', name: 'Delete me' })
      const manager = attachmentManager(service)
      const startUpload = manager.startUpload.bind(manager)
      let continueUpload!: () => void
      const paused = new Promise<void>((resolve) => (continueUpload = resolve))
      vi.spyOn(manager, 'startUpload').mockImplementation(async (...args) => {
        await paused
        return startUpload(...args)
      })

      const upload = service.startAttachmentUpload(snapshot.room.id, 'late.txt', 1)
      await vi.waitFor(() => expect(manager.startUpload).toHaveBeenCalledOnce())
      const deletion = service.deleteRoom(snapshot.room.id)
      expect(() => service.startAttachmentUpload(snapshot.room.id, 'rejected.txt', 1)).toThrow(
        'room_deleting'
      )
      expect(service.db.core.get(snapshot.room.id)).toBeDefined()

      continueUpload()
      const created = await upload
      const pendingPath = join(root, 'room-attachments', '.uploads', `${created.uploadId}.part`)
      await deletion
      await expect(access(pendingPath)).rejects.toThrow()
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries persisted external cleanup after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-delete-retry-'))
    const path = join(root, 'rooms.db')
    const firstHarness = runtime()
    firstHarness.cleanupDeletedRoomResources = vi.fn(async () => {
      throw new Error('ssh_disconnected')
    })
    const first = new RoomService(path, firstHarness)
    const snapshot = first.createRoom({ projectId: 'project-1', name: 'Delete me' })
    const message = first.db.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'attachment',
      attachments: [
        {
          id: crypto.randomUUID(),
          fileName: 'evidence.txt',
          mimeType: 'text/plain',
          byteSize: 1,
          localPath: join(root, 'evidence.txt'),
          createdAt: 1
        }
      ]
    }).message
    first.db.recordAttachmentDrop(
      message.attachments[0].id,
      'ssh-1',
      '/repo/.orca/drops/evidence.txt'
    )
    await first.deleteRoom(snapshot.room.id)
    expect(first.db.listRoomDeletionCleanup()).toHaveLength(1)
    first.close()

    const secondHarness = runtime()
    secondHarness.cleanupDeletedRoomResources = vi.fn(async () => undefined)
    const second = new RoomService(path, secondHarness)
    try {
      await vi.waitFor(() => expect(second.db.listRoomDeletionCleanup()).toEqual([]))
      expect(secondHarness.cleanupDeletedRoomResources).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: snapshot.room.id,
          drops: [{ connectionId: 'ssh-1', remotePath: '/repo/.orca/drops/evidence.txt' }]
        })
      )
    } finally {
      second.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function roomGenerationIds(store: object): string[] {
  return [...(store as { roomGenerations: Map<string, number> }).roomGenerations.keys()]
}

function transcriptGenerationIds(service: RoomService): string[] {
  const bridge = (service as unknown as { transcriptBridge: object }).transcriptBridge
  return [...(bridge as { generations: Map<string, number> }).generations.keys()]
}

function attachmentManager(service: RoomService): {
  startUpload(roomId: string, fileName: string, byteSize: number): Promise<string>
} {
  return (
    service.attachmentTransfers as unknown as {
      manager: {
        startUpload(roomId: string, fileName: string, byteSize: number): Promise<string>
      }
    }
  ).manager
}
