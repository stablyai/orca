import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import type {
  Room,
  RoomEvent,
  RoomMessage,
  RoomMessagePage,
  RoomParticipant,
  RoomSnapshot,
  RoomUnread
} from '../../../shared/rooms'
import { RoomDatabase } from './database'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RoomDeliveryWorker } from './delivery-worker'
import {
  createRoomHarnessAdapters,
  type RoomHarnessAdapter,
  type RoomHarnessRuntime
} from './harness-adapter'
import { RoomTranscriptBridge } from './transcript-bridge'
import { RoomParticipantController } from './participant-controller'
import { RoomArchive } from './archive'
import { RoomEventBus, type RoomListener } from './event-bus'
import { RoomMessageController, type SendRoomMessageInput } from './message-controller'
import { RoomArchiveTransferStore } from './archive-transfers'
import { RoomAttachmentManager } from './attachments'
import { RoomAttachmentTransferStore } from './attachment-transfers'
import { RoomDeletionCoordinator } from './room-deletion'
import { RoomWorkController } from './work-controller'
import { addRoomMessageNotificationContext } from './room-event-notification'
import { RoomQueueController } from './queue-controller'
import { activateRoomParticipants } from './room-activation'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { RoomQueueEditController } from './queue-edit-controller'
import { RoomParticipantSurface } from './participant-surface'

export type { RoomParticipantConnection } from './participant-membership'

export class RoomService {
  readonly db: RoomDatabase
  readonly archiveTransfers: RoomArchiveTransferStore
  readonly attachmentTransfers: RoomAttachmentTransferStore
  private readonly adapters
  private readonly deliveryWorker: RoomDeliveryWorker
  readonly transcriptBridge: RoomTranscriptBridge
  readonly participantController: RoomParticipantController
  readonly queue: RoomQueueController
  private readonly events: RoomEventBus
  private readonly messageController: RoomMessageController
  readonly queueEdits: RoomQueueEditController
  private readonly participantSurface: RoomParticipantSurface
  private readonly deletion: RoomDeletionCoordinator
  private readonly work: RoomWorkController

  constructor(
    path: string,
    private readonly runtime: RoomHarnessRuntime,
    adapters: Record<string, RoomHarnessAdapter> = createRoomHarnessAdapters(runtime)
  ) {
    this.events = new RoomEventBus(runtime.emitRoomEvent?.bind(runtime))
    const focusTerminal = runtime.focusTerminal?.bind(runtime)
    const hideRendererStatus = runtime.hideRoomAgentStatusFromRenderer?.bind(runtime)
    const publishAgentSession = runtime.publishRoomAgentProviderSession?.bind(runtime)
    const publishStructuredSession = runtime.publishStructuredAgentSessionTab?.bind(runtime)
    this.db = new RoomDatabase(
      path,
      (sessionId) => getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.options
    )
    this.archiveTransfers = new RoomArchiveTransferStore(new RoomArchive(this.db))
    const attachmentRoot =
      path === ':memory:'
        ? join(tmpdir(), 'orca-room-attachments', randomUUID())
        : join(dirname(path), 'room-attachments')
    const attachments = new RoomAttachmentManager(attachmentRoot)
    this.attachmentTransfers = new RoomAttachmentTransferStore(this.db, attachments)
    this.adapters = adapters
    this.transcriptBridge = new RoomTranscriptBridge(
      this.db,
      this.adapters,
      (roomId, event) => this.emitEvent(roomId, event),
      (participantId, userMessage) => this.deliveryWorker.confirmTurn(participantId, userMessage),
      () => this.deliveryWorker.wake()
    )
    this.participantController = new RoomParticipantController(
      this.db,
      this.adapters,
      this.transcriptBridge,
      (roomId, event) => this.emitEvent(roomId, event),
      hideRendererStatus
    )
    this.participantSurface = new RoomParticipantSurface(
      this.db,
      this.participantController,
      focusTerminal,
      hideRendererStatus,
      publishAgentSession,
      publishStructuredSession
    )
    this.deliveryWorker = new RoomDeliveryWorker(
      this.db,
      this.adapters,
      attachments,
      (roomId, event) => this.emitEvent(roomId, event),
      (participantId) => this.participantController.ensureReady(participantId),
      undefined,
      () => runtime.roomLiveSteeringEnabled?.() === true
    )
    this.messageController = new RoomMessageController(
      this.db,
      attachments,
      (roomId, event) => this.emitEvent(roomId, event),
      () => this.deliveryWorker.wake()
    )
    this.queue = new RoomQueueController(
      this.db,
      this.messageController,
      this.deliveryWorker,
      this.assertWritable
    )
    this.work = new RoomWorkController(
      this.db,
      this.deliveryWorker,
      this.transcriptBridge,
      this.adapters,
      (roomId, event) => this.emitEvent(roomId, event)
    )
    this.deletion = new RoomDeletionCoordinator(
      this.db,
      this.deliveryWorker,
      this.participantController,
      this.archiveTransfers,
      this.attachmentTransfers,
      this.events,
      runtime.cleanupDeletedRoomResources?.bind(runtime) ?? (async () => undefined)
    )
    this.queueEdits = new RoomQueueEditController(
      this.db,
      attachments,
      (roomId, event) => this.emitEvent(roomId, event),
      () => this.deliveryWorker.wake(),
      this.assertWritable,
      (roomId, action) => this.deletion.run(roomId, action)
    )
    this.deliveryWorker.start()
    this.participantController.startHibernationSweep()
    this.deletion.start()
  }

  close(): void {
    this.deletion.dispose()
    this.participantController.dispose()
    this.deliveryWorker.dispose()
    this.transcriptBridge.dispose()
    this.events.clear()
    this.archiveTransfers.clear()
    this.attachmentTransfers.clear()
    this.db.close()
  }

  wakeDeliveries = (): void => this.deliveryWorker.wake()

  createRoom = (input: Parameters<RoomDatabase['createRoom']>[0]): RoomSnapshot =>
    this.db.createRoom(input)

  listRooms = (projectId: string): Room[] => this.db.core.list(projectId)

  snapshot = (roomId: string, readerKey = 'user'): RoomSnapshot =>
    this.db.snapshot(roomId, readerKey)

  async prepareSnapshot(roomId: string): Promise<void> {
    const participants = this.db.participants.list(roomId)
    if (participants.some((participant) => participant.providerSession?.transport === 'machine')) {
      // Load durable metadata, not provider children or their live options.
      await this.runtime.ensureStructuredAgentSessionHost?.().catch(() => {})
    }
  }

  activateRoom = async (roomId: string, readerKey = 'user'): Promise<RoomSnapshot> =>
    this.deletion.run(roomId, () => this.activateRoomNow(roomId, readerKey))

  private async activateRoomNow(roomId: string, readerKey: string): Promise<RoomSnapshot> {
    const snapshot = this.db.snapshot(roomId, readerKey)
    await activateRoomParticipants(
      snapshot.participants,
      this.participantController,
      this.transcriptBridge,
      (participant) => this.participantSurface.publish(participant)
    )
    return this.db.snapshot(roomId, readerKey)
  }

  subscribe(roomId: string, readerKey: string, listener: RoomListener): () => void {
    void this.activateRoom(roomId, readerKey).catch(() => {})
    return this.events.subscribe(
      roomId,
      { type: 'snapshot', snapshot: this.db.snapshot(roomId, readerKey) },
      listener
    )
  }

  listMessages = (roomId: string, beforeSequence: number | null, limit = 100): RoomMessagePage =>
    this.db.messages.list(roomId, beforeSequence, limit)

  assertWritable = (roomId: string): void => this.deletion.assertAvailable(roomId)

  getUserParticipant = (roomId: string): RoomParticipant => this.db.participants.getUser(roomId)

  sendMessage(input: SendRoomMessageInput): Promise<RoomMessage> {
    return this.deletion.run(input.roomId, () => this.messageController.send(input))
  }

  updateMessage(id: string, senderIdentity: string, body: string): RoomMessage {
    this.assertWritable(this.db.messages.get(id).roomId)
    return this.messageController.update(id, senderIdentity, body)
  }

  async deleteMessage(id: string, senderIdentity: string): Promise<void> {
    const roomId = this.db.messages.get(id).roomId
    this.messageController.assertDeletable(id, senderIdentity)
    await this.deletion.run(roomId, async () => {
      this.messageController.assertDeletable(id, senderIdentity)
      await this.work.stopMessage(id)
      await this.messageController.delete(id, senderIdentity)
    })
  }

  markRead(roomId: string, readerKey: string, sequence: number): RoomUnread {
    this.assertWritable(roomId)
    return this.messageController.markRead(roomId, readerKey, sequence)
  }

  async addParticipant(
    input: Parameters<RoomParticipantController['add']>[0]
  ): Promise<RoomParticipant> {
    return this.deletion.run(input.roomId, () => this.participantController.add(input))
  }

  participantForTerminal = (handle: string): RoomParticipant | null =>
    this.db.participants.findByTerminalHandle(handle)

  participantForPane = (paneKey: string): RoomParticipant | null =>
    this.db.participants.findByPaneKey(paneKey)

  currentTurnDeliveryIdForPane(paneKey: string): string | null {
    const participant = this.participantForPane(paneKey)
    return participant ? this.transcriptBridge.currentTurnDeliveryId(participant.id) : null
  }

  async revealParticipant(id: string, viewMode: 'terminal' | 'chat'): Promise<void> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantSurface.reveal(id, viewMode))
  }

  wakeParticipant = (id: string): Promise<RoomParticipant> =>
    this.deletion.run(this.db.participants.get(id).roomId, () =>
      this.participantController.ensureReady(id)
    )

  hideParticipantTerminal = (handle: string): void => this.participantSurface.hide(handle)

  removeParticipant(id: string): Promise<void> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantController.remove(id))
  }

  async compactParticipant(id: string): Promise<RoomParticipant> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantController.compact(id))
  }

  async controlParticipant(id: string, command: string): Promise<RoomParticipant> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantController.control(id, command))
  }

  async reconfigureParticipant(
    id: string,
    preferences: Parameters<RoomParticipantController['reconfigure']>[1]
  ): Promise<RoomParticipant> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantController.reconfigure(id, preferences))
  }

  retryDelivery(id: string): void {
    const roomId = this.db.messages.get(this.db.messages.deliveries.get(id).messageId).roomId
    this.assertWritable(roomId)
    const delivery = this.db.messages.deliveries.retry(id)
    this.emitEvent(roomId, { type: 'delivery.updated', delivery })
    this.deliveryWorker.wake()
  }

  stopRoom = (roomId: string): Promise<number> =>
    this.deletion.run(roomId, () => this.work.stop(roomId))

  resumeRoom = (roomId: string): Promise<number> =>
    this.deletion.run(roomId, () => this.work.resume(roomId))

  recordAttachmentDrop(attachmentId: string, connectionId: string, remotePath: string): void {
    this.db.recordAttachmentDrop(attachmentId, connectionId, remotePath)
  }

  deleteRoom = (roomId: string): Promise<void> => this.deletion.delete(roomId)

  finishArchiveImport(transferId: string) {
    return this.deletion.run(this.archiveTransfers.importRoomId(transferId), () =>
      this.archiveTransfers.finishImport(transferId)
    )
  }

  startArchiveExport(roomId: string, fileName: string) {
    return this.deletion.run(roomId, () => this.archiveTransfers.startExport(roomId, fileName))
  }

  startAttachmentUpload(roomId: string, fileName: string, byteSize: number) {
    return this.deletion.run(roomId, () =>
      this.attachmentTransfers.startUpload(roomId, fileName, byteSize)
    )
  }

  startAttachmentDownload(roomId: string, attachmentId: string) {
    return this.deletion.run(roomId, () =>
      this.attachmentTransfers.startDownload(roomId, attachmentId)
    )
  }

  ingestAgentStatus = (event: AgentHookEventPayload & { receivedAt: number }): void =>
    this.participantController.ingestStatus(event)

  ingestClaudeStatusLine = (event: ClaudeStatusLineRateLimits): void =>
    this.participantController.ingestClaudeStatusLine(event)

  emitEvent(roomId: string, event: RoomEvent): void {
    if (event.type === 'delivery.updated' || event.type === 'room.updated') {
      event = { ...event, workState: this.db.messages.deliveries.workState(roomId) }
    }
    this.events.emit(roomId, addRoomMessageNotificationContext(this.db, roomId, event))
    if (event.type === 'participant.removed') {
      this.queue.wake()
    }
  }
}
