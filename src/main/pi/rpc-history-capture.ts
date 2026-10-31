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

/** Last entry reconciled with the journal; null means the session has no entries yet. */
export type PiHistoryAnchor = { entry: string | null }

export type PiHistoryCaptureDeps = {
  /** Persist the reconciled Pi leaf and journal cursor in the open handle. */
  persistResumePoint?: (write: PiHistoryResumePointWrite) => Promise<void>
}

export type PiHistoryCaptureParts = {
  sessionId: string
  fence: number
  connection: Pick<PiRpcConnection, 'request'>
  sink: StructuredAgentSessionEventSink | undefined
  /** Wait until every timeline event is accepted by the sink. */
  drained: () => Promise<void>
  activity: () => number
  handle: () => AgentSessionProviderHandle | null
  persist?: PiHistoryCaptureDeps['persistResumePoint']
  logger: StructuredAgentSessionLogger
}

/** Save reconciled cursors off the send path; failed or superseded captures leave later opens to skip ambiguous history. */
export class PiHistoryCapture {
  private anchor: PiHistoryAnchor | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly parts: () => PiHistoryCaptureParts) {}

  // Capture is constructed before its session dependencies exist.
  static forSession(
    session: Parameters<typeof piRpcHistoryCaptureParts>[0],
    deps: () => Parameters<typeof piRpcHistoryCaptureParts>[1]
  ): PiHistoryCapture {
    return new PiHistoryCapture(() => piRpcHistoryCaptureParts(session, deps()))
  }

  /** Continue only when the opening claim reached Pi's current leaf. */
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
    // The persisted claim governs future opens; this anchor only bounds the next read.
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
