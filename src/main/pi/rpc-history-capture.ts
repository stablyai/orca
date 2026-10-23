import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { readPiEntries } from './rpc-history-catch-up'
import { piBranchInTree, piBranchSince } from './rpc-history-import'
import { encodePiHistoryClaim } from './rpc-history-journal-view'
import type { PiRpcConnection, PiRpcSession } from './rpc-session'

export type PiHistoryResumePointWrite = {
  sessionId: string
  fence: number
  handle: AgentSessionProviderHandle
}

/** Where the chat's journal and Pi's entries were last known to meet; null is a session with no
 *  entries yet. */
export type PiHistoryAnchor = { entry: string | null }

export type PiHistoryCaptureDeps = {
  /** Revises the open's handle in place with where the chat's journal meets Pi's entries. */
  persistResumePoint?: (write: PiHistoryResumePointWrite) => Promise<void>
}

export type PiHistoryCaptureParts = {
  sessionId: string
  fence: number
  connection: Pick<PiRpcConnection, 'request'>
  sink: StructuredAgentSessionEventSink | undefined
  /** Resolves once the timeline holds no events the sink refused. */
  drained: () => Promise<void>
  /** Changes whenever the chat's Pi does anything after a turn. */
  activity: () => number
  handle: () => AgentSessionProviderHandle | null
  persist?: PiHistoryCaptureDeps['persistResumePoint']
  logger: StructuredAgentSessionLogger
}

/**
 * After each turn the chat's Pi ran, saves the claim that its entries are shown: Pi's leaf, and the
 * journal position its rows reached. Bookkeeping only: never awaited by the turn, never failing a
 * send. A capture the chat moved past, or one that fails, saves nothing, so the next open treats
 * that turn as not accounted for and skips rather than duplicates.
 */
export class PiHistoryCapture {
  private anchor: PiHistoryAnchor | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly parts: () => PiHistoryCaptureParts) {}

  /** Built with its session, before the parts it reads when a turn ends exist. */
  static forSession(
    session: Parameters<typeof piRpcHistoryCaptureParts>[0],
    deps: () => Parameters<typeof piRpcHistoryCaptureParts>[1]
  ): PiHistoryCapture {
    return new PiHistoryCapture(() => piRpcHistoryCaptureParts(session, deps()))
  }

  /** Only an open that left the claim at Pi's current leaf lets captures continue from it. */
  start(anchor: PiHistoryAnchor | undefined): void {
    this.anchor = anchor
  }

  turnEnded(): void {
    const deps = this.parts()
    const anchor = this.anchor
    if (!anchor || !deps.persist) {
      return
    }
    const activity = deps.activity()
    this.queue = this.queue
      .then(() => this.capture(deps, anchor, activity))
      .catch((error: unknown) =>
        deps.logger.warn('Pi turn was not recorded for catch-up', {
          scope: 'pi-history-capture',
          sessionId: deps.sessionId,
          error
        })
      )
  }

  private async capture(
    deps: PiHistoryCaptureParts,
    anchor: PiHistoryAnchor,
    activity: number
  ): Promise<void> {
    const moved = () => this.anchor !== anchor || deps.activity() !== activity
    await deps.drained()
    const sink = deps.sink
    const written = await sink?.written?.()
    const history = sink?.journalHistory?.()
    if (!written?.ok || !history || moved()) {
      return
    }
    // Read before Pi's leaf: a row landing after this is not claimed.
    const through = history.cursor()
    const answer = await readPiEntries(deps.connection, anchor.entry)
    const branch =
      anchor.entry === null ? piBranchInTree(answer, null) : piBranchSince(answer, anchor.entry)
    const handle = deps.handle()
    if (moved() || !branch || answer.leafId === null || !handle) {
      return
    }
    const entry = answer.leafId
    // The anchor only keeps the next read small; the saved claim is what an open trusts.
    this.anchor = { entry }
    await deps.persist?.({
      sessionId: deps.sessionId,
      fence: deps.fence,
      handle: {
        ...handle,
        resumeCursor: encodePiHistoryClaim({
          entry,
          epoch: through.epoch,
          sequence: through.sequence
        })
      }
    })
  }
}

/** A session's parts, read when a turn ends: the capture is built before they exist. */
function piRpcHistoryCaptureParts(
  session: Pick<PiRpcSession, 'input' | 'connection' | 'lane' | 'turns' | 'openedLink'>,
  deps: PiHistoryCaptureDeps & { logger: StructuredAgentSessionLogger }
): PiHistoryCaptureParts {
  return {
    sessionId: session.input.identity.sessionId,
    fence: session.input.fence,
    connection: session.connection,
    sink: session.input.events,
    drained: () => session.lane.drained(),
    activity: () => session.turns.activity,
    handle: () => session.openedLink?.handle ?? null,
    ...(deps.persistResumePoint ? { persist: deps.persistResumePoint } : {}),
    logger: deps.logger
  }
}
