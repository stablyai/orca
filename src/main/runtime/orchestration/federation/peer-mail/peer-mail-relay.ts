import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { PeerMailRelayPayload } from '../../../../../shared/rpc-contract/orchestration-peer-mail-params'
import { resolveBareOrchestrationRecipient } from '../../../rpc/methods/orchestration/messaging/recipient-routing'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { MessageRow } from '../../db/orchestration-records'
import { federationRelayRetryDelayMs } from '../relay/federation-relay-scheduler'
import { HeldPeerConversations } from './held-peer-conversations'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'
import { peerMailLocalRecipient } from './peer-mail-delivery'
import { presentImportedPeerItem } from '../../mailbox/formatting/imported-peer-item-presentation'
import { importRemoteOwnedItem } from '../../db/remote-owned/remote-owned-import'
import {
  closeRemoteRunLinksOfChangedPairing,
  closeRemoteRunLinksOfRemovedServer,
  dueRemoteResendsNow,
  getRemoteRunLink,
  listLiveRemoteRunLinkEnvironments,
  noteRemoteRunLinkError,
  remoteServerPin
} from '../../db/remote-owned/remote-run-links'
import { resendOwedRemoteActions } from '../remote-owned/remote-owed-actions'
import { remoteServerName } from '../remote-owned/remote-owned-reads'
import { isRemoteServerUnreachable } from '../remote-owned/remote-server-unreachable'

// Under the relay edge's idle cutoff, so an idle pull ends by itself instead of being dropped.
const PULL_WAIT_MS = 20_000
const PULL_TIMEOUT_MS = PULL_WAIT_MS + 15_000

const PulledPeerMail = z.object({
  items: z.array(
    z.object({
      conversationId: z.string(),
      sequence: z.number().int().positive(),
      messageId: z.string(),
      kind: z.string().optional(),
      payload: z.string()
    })
  )
})

/** What this Orca's pull loop last heard from a paired server; nothing until its first pull settles. */
export type PeerServerAnswerStatus = {
  /** When the server last answered a pull (an idle pull answers after its wait). */
  answeredAt?: number
  /** Set while pulls get no answer at all; cleared by the next answer. */
  unreachableSince?: number
}

type Loop = {
  db: OrchestrationDb
  stopped: boolean
  resending: boolean
  held: HeldPeerConversations
}

/** One pull loop per paired server this Orca opened conversations with or coordinates Runs on. The
 *  server never dials back: each pull waits there for queued items, imports them, then acknowledges
 *  them. Stops and cancels this Orca owes the server go out on the same loop. */
export class PeerMailRelay {
  private readonly loops = new Map<string, Loop>()
  private readonly answers = new Map<string, PeerServerAnswerStatus>()

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly transport: () => OrchestrationEnvironmentTransport | null
  ) {}

  ensure(): void {
    if (!this.transport()) {
      return
    }
    const db = this.runtime.getOrchestrationDb()
    const environments = new Set([
      ...db.listHomePeerMailEnvironments(),
      ...listLiveRemoteRunLinkEnvironments(db)
    ])
    for (const environmentId of environments) {
      const current = this.loops.get(environmentId)
      if (current && !current.stopped && current.db === db) {
        continue
      }
      const loop: Loop = { db, stopped: false, resending: false, held: new HeldPeerConversations() }
      this.loops.set(environmentId, loop)
      void this.run(environmentId, loop)
    }
  }

  answerStatus(environmentId: string): PeerServerAnswerStatus | undefined {
    return this.answers.get(environmentId)
  }

  stop(): void {
    for (const loop of this.loops.values()) {
      loop.stopped = true
    }
    this.loops.clear()
  }

  private isCurrent(environmentId: string, loop: Loop): boolean {
    return (
      !loop.stopped &&
      this.loops.get(environmentId) === loop &&
      this.runtime.getOrchestrationDb() === loop.db
    )
  }

  private async run(environmentId: string, loop: Loop): Promise<void> {
    let failures = 0
    // Named while it is still paired, so a removal can say which server went.
    const serverName = remoteServerName(this.runtime, environmentId)
    while (this.isCurrent(environmentId, loop)) {
      try {
        await this.pullOnce(environmentId, loop)
        if (failures > 0) {
          // The server answers again: what this Orca owes it goes out now, not after its backoff.
          dueRemoteResendsNow(loop.db, environmentId)
          this.resendOwed(environmentId, loop)
        }
        failures = 0
      } catch {
        if (this.isEnvironmentRemoved(environmentId)) {
          // A removed server cannot answer for its Runs' work again; their Tasks here fail with why.
          try {
            closeRemoteRunLinksOfRemovedServer(
              loop.db,
              environmentId,
              `${serverName} was removed from this Orca's paired servers.`,
              (handle, type) => this.runtime.notifyMessageArrived(handle, type)
            )
          } catch (error) {
            console.warn(
              `[orchestration] Settling the Runs on removed server ${environmentId} failed:`,
              error
            )
          }
          break
        }
        failures += 1
        await new Promise<void>((resolve) => {
          setTimeout(resolve, federationRelayRetryDelayMs(failures)).unref?.()
        })
      }
    }
    if (this.loops.get(environmentId) === loop) {
      this.loops.delete(environmentId)
    }
  }

  /** A store read error keeps the loop retrying rather than ending it. */
  private isEnvironmentRemoved(environmentId: string): boolean {
    try {
      return this.transport()?.hasEnvironment?.(environmentId) === false
    } catch {
      return false
    }
  }

  private async pullOnce(environmentId: string, loop: Loop): Promise<void> {
    // A re-pair is noticed here, not only by the next call through a link: its held Tasks fail now.
    const server = this.runtime.resolveOrchestrationWorkerServer(environmentId)
    closeRemoteRunLinksOfChangedPairing(
      loop.db,
      remoteServerPin(server),
      server.name,
      (handle, type) => this.runtime.notifyMessageArrived(handle, type)
    )
    this.resendOwed(environmentId, loop)
    const { holdBack, waitMs } = loop.held.forPull(Date.now(), PULL_WAIT_MS)
    const response = await this.runtime
      .callOrchestrationWorkerServer(
        environmentId,
        'orchestration.peerMailPull',
        { waitMs, ...(holdBack.length > 0 ? { holdBack } : {}) },
        PULL_TIMEOUT_MS
      )
      .catch((error: unknown) => {
        if (isRemoteServerUnreachable(error)) {
          const known = this.answers.get(environmentId)
          this.answers.set(environmentId, {
            ...known,
            unreachableSince: known?.unreachableSince ?? Date.now()
          })
        }
        throw error
      })
    this.answers.set(environmentId, { answeredAt: Date.now() })
    if (!this.isCurrent(environmentId, loop)) {
      return
    }
    const { items } = PulledPeerMail.parse(response)
    if (items.length === 0) {
      return
    }
    const through = new Map<string, number>()
    const stuck = new Map<string, unknown>()
    // One clock for the batch, and a held conversation stays skipped to its end: none of its later
    // items is imported, so the ack never passes the item it is waiting to retry.
    const now = Date.now()
    const heldBack = new Set<string>()
    let onlyHeldBack = true
    for (const item of items) {
      // An item that cannot be read holds back its own conversation only; the others keep moving.
      if (stuck.has(item.conversationId) || heldBack.has(item.conversationId)) {
        continue
      }
      if (loop.held.isWaiting(item.conversationId, now)) {
        heldBack.add(item.conversationId)
        continue
      }
      onlyHeldBack = false
      try {
        const stored = this.importItem(loop.db, environmentId, item)
        // Wake before the ack: a replay after a failed ack finds the row stored and stays quiet.
        if (stored) {
          this.runtime.notifyMessageArrived(stored.to, stored.type)
        }
      } catch (error) {
        stuck.set(item.conversationId, error)
        loop.held.failed(item.conversationId, now)
        noteRemoteRunLinkError(loop.db, item.conversationId, error)
        continue
      }
      loop.held.read(item.conversationId)
      through.set(
        item.conversationId,
        Math.max(through.get(item.conversationId) ?? 0, item.sequence)
      )
    }
    if (through.size > 0) {
      await this.runtime.callOrchestrationWorkerServer(
        environmentId,
        'orchestration.peerMailAck',
        {
          acknowledgments: [...through].map(([conversationId, throughSequence]) => ({
            conversationId,
            throughSequence
          }))
        },
        15_000
      )
    }
    const [failure] = stuck.values()
    if (failure !== undefined) {
      console.warn(
        `[orchestration] Holding back ${stuck.size} conversation(s) from ${environmentId}:`,
        failure instanceof Error ? failure.message : failure
      )
    }
    if (onlyHeldBack) {
      // Only conversations still waiting came back (an older server, or past the cap): no hot re-pull.
      await loop.held.untilFirstDue(heldBack, now, PULL_WAIT_MS)
    }
  }

  /** Stops and cancels owed to the server go out beside the pull, one batch at a time, so a slow answer never holds mail back. */
  private resendOwed(environmentId: string, loop: Loop): void {
    if (loop.resending) {
      return
    }
    loop.resending = true
    void resendOwedRemoteActions(this.runtime, loop.db, environmentId)
      .catch((error: unknown) => {
        console.warn(`[orchestration] Owed actions for ${environmentId} failed:`, error)
      })
      .finally(() => {
        loop.resending = false
      })
  }

  /** A Run this Orca coordinates there owns its conversation's items; any other is a peer-mail reply. */
  private importItem(
    db: OrchestrationDb,
    environmentId: string,
    item: z.infer<typeof PulledPeerMail>['items'][number]
  ): { to: string; type: MessageRow['type'] } | undefined {
    if (getRemoteRunLink(db, item.conversationId)) {
      const server = this.runtime.resolveOrchestrationWorkerServer(environmentId)
      return importRemoteOwnedItem(db, remoteServerPin(server), item, {
        name: server.name,
        notify: (handle, type) => this.runtime.notifyMessageArrived(handle, type)
      })
    }
    const stored = this.importReply(db, environmentId, item)
    return stored ? { to: stored.to_handle, type: stored.type } : undefined
  }

  /** Stores a pulled reply once; a replay after a crash before the ack finds the stored row. */
  private importReply(
    db: OrchestrationDb,
    environmentId: string,
    item: z.infer<typeof PulledPeerMail>['items'][number]
  ): MessageRow | undefined {
    const conversation = db.getPeerMailConversation(item.conversationId)
    const payload = PeerMailRelayPayload.safeParse(safeJson(item.payload))
    if (
      conversation?.role !== 'home' ||
      conversation.environment_id !== environmentId ||
      !payload.success
    ) {
      // Nothing here can read it; acknowledging keeps the server's queue moving.
      console.warn(
        `[orchestration] Dropped unreadable reply ${item.messageId} from ${environmentId}`
      )
      return undefined
    }
    const handle = peerMailLocalRecipient(this.runtime, conversation)
    // Peer-mail replies come home to this Orca's own sender handle, never a terminal agent's id.
    const recipient = resolveBareOrchestrationRecipient({ runtime: this.runtime, db, handle })
    const presented = presentImportedPeerItem({
      kind: 'peer_mail',
      senderLabel: payload.data.senderLabel,
      body: payload.data.body
    })
    const stored = db.insertPeerMailMessage({
      conversationId: conversation.conversation_id,
      remoteParty: payload.data.fromAddress,
      message: {
        id: item.messageId,
        from: presented.from,
        to: recipient.ok ? recipient.to : handle,
        subject: payload.data.subject,
        body: presented.body,
        threadId: payload.data.threadId ?? undefined,
        runId: recipient.ok ? recipient.runId : undefined
      }
    })
    return stored.duplicate ? undefined : stored.message
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
