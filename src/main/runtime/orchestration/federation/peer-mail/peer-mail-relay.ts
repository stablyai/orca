import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { PeerMailRelayPayload } from '../../../../../shared/rpc-contract/orchestration-peer-mail-params'
import { resolveBareOrchestrationRecipient } from '../../../rpc/methods/orchestration/messaging/recipient-routing'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { MessageRow } from '../../db/orchestration-records'
import { federationRelayRetryDelayMs } from '../relay/federation-relay-scheduler'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'
import { peerMailLocalRecipient } from './peer-mail-delivery'

// Under the relay edge's idle cutoff, so an idle pull ends by itself instead of being dropped.
const PULL_WAIT_MS = 20_000
const PULL_TIMEOUT_MS = PULL_WAIT_MS + 15_000

const PulledPeerMail = z.object({
  items: z.array(
    z.object({
      conversationId: z.string(),
      sequence: z.number().int().positive(),
      messageId: z.string(),
      payload: z.string()
    })
  )
})

type Loop = { db: OrchestrationDb; stopped: boolean }

/** One pull loop per paired server this Orca opened conversations with. The server never dials
 *  back: each pull waits there for a reply, stores it as local mail, then acknowledges it. */
export class PeerMailRelay {
  private readonly loops = new Map<string, Loop>()

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly transport: () => OrchestrationEnvironmentTransport | null
  ) {}

  ensure(): void {
    if (!this.transport()) {
      return
    }
    const db = this.runtime.getOrchestrationDb()
    for (const environmentId of db.listHomePeerMailEnvironments()) {
      const current = this.loops.get(environmentId)
      if (current && !current.stopped && current.db === db) {
        continue
      }
      const loop: Loop = { db, stopped: false }
      this.loops.set(environmentId, loop)
      void this.run(environmentId, loop)
    }
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
    while (this.isCurrent(environmentId, loop)) {
      try {
        await this.pullOnce(environmentId, loop)
        failures = 0
      } catch {
        if (this.isEnvironmentRemoved(environmentId)) {
          // A removed server cannot answer; the next ensure re-arms it if it is added back.
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
    const response = await this.runtime.callOrchestrationWorkerServer(
      environmentId,
      'orchestration.peerMailPull',
      { waitMs: PULL_WAIT_MS },
      PULL_TIMEOUT_MS
    )
    if (!this.isCurrent(environmentId, loop)) {
      return
    }
    const { items } = PulledPeerMail.parse(response)
    if (items.length === 0) {
      return
    }
    const through = new Map<string, number>()
    for (const item of items) {
      const stored = this.importReply(loop.db, environmentId, item)
      // Wake before the ack: a replay after a failed ack finds the row stored and stays quiet.
      if (stored) {
        this.runtime.notifyMessageArrived(stored.to_handle, stored.type)
      }
      through.set(
        item.conversationId,
        Math.max(through.get(item.conversationId) ?? 0, item.sequence)
      )
    }
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
    const recipient = resolveBareOrchestrationRecipient({ runtime: this.runtime, db, handle })
    const stored = db.insertPeerMailMessage({
      conversationId: conversation.conversation_id,
      remoteParty: payload.data.fromAddress,
      message: {
        id: item.messageId,
        from: payload.data.senderLabel,
        to: recipient.ok ? recipient.to : handle,
        subject: payload.data.subject,
        body: payload.data.body,
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
