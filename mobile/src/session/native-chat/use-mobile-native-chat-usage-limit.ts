import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  latestNativeChatUsageLimitCut,
  NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE
} from '../../../../src/shared/native-chat/native-chat-usage-limit-cut'
import {
  nativeChatUsageLimitAutoContinueKind,
  usageLimitContinueAtForCut,
  usageLimitContinueStateForCut,
  type NativeChatUsageLimitAutoContinueKind
} from '../../../../src/shared/native-chat/native-chat-usage-limit-auto-continue'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../src/shared/agent-session/options/agent-session-options-result'
import type { AgentJournalCursor } from '../../../../src/shared/agent-session/journal/agent-session-journal-identity'
import { mobileStructuredSessionStatusFeed } from './agent-session/mobile-structured-session-status-feed'
import { callAgentSession } from './agent-session/mobile-structured-agent-session-rpc'
import type {
  MobileStructuredAgentSessionArgs,
  StructuredMobileSession
} from './agent-session/mobile-structured-agent-session-contract'

/** The usage-limit row the person can act on: the latest cut while nothing is running or sending. */
export type MobileNativeChatUsageLimit = {
  turnItemId: string
  /** The host's automatic continue for this cut; null when it has none to show. */
  autoContinue: Exclude<NativeChatUsageLimitAutoContinueKind, 'off'> | null
  /** The reset the host's automatic continue waits for; later than the cut's while the account is spent. */
  continueAt: number | undefined
  /** Null on a host that refuses "Don't continue" from a phone. */
  cancel: (() => void) | null
  cancelling: boolean
  cancelFailed: boolean
  /** Undefined until the host first answers for this cut; later re-asks keep the last answer. */
  canSwitchAccount: boolean | undefined
  /** Sends desktop's "Continue where you left off." for this cut. */
  continueNow: () => void
}

const noSubscription = (): (() => void) => () => {}

export function useMobileNativeChatUsageLimit(
  chat: Pick<
    MobileStructuredAgentSessionArgs,
    'client' | 'sessionId' | 'enabled' | 'connected' | 'hostSupport'
  >,
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
    cursor?: AgentJournalCursor | null
  },
  /** Busy: working or sending, when the cut is not the chat's last word. */
  turn: { busy: boolean; send: StructuredMobileSession['sendWithOutcome'] }
): MobileNativeChatUsageLimit | null {
  const { client, sessionId, hostSupport } = chat
  const live = chat.enabled && chat.connected
  const { items, submissions } = journal
  // While the chat works or sends no cut is actionable, so skip the transcript scan per chunk.
  const cut = useMemo(
    () => (turn.busy ? null : latestNativeChatUsageLimitCut(items, submissions)),
    [turn.busy, items, submissions]
  )
  const turnItemId = cut?.turnItemId ?? null
  const resetsAt = cut?.resetsAt
  // The host alone continues the chat at its reset; the phone only shows and cancels that.
  const feed =
    live &&
    client &&
    sessionId &&
    turnItemId !== null &&
    resetsAt !== undefined &&
    hostSupport?.statusFeed === true &&
    hostSupport.usageLimitAutoContinue
      ? mobileStructuredSessionStatusFeed(client)
      : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readState = useCallback(
    () =>
      feed && sessionId
        ? usageLimitContinueStateForCut(feed.getSnapshot().get(sessionId)?.usageLimitContinue, cut)
        : undefined,
    [feed, sessionId, cut]
  )
  const state = useSyncExternalStore(subscribe, readState, readState)
  const readContinueAt = useCallback(
    () =>
      feed && sessionId
        ? usageLimitContinueAtForCut(feed.getSnapshot().get(sessionId)?.usageLimitContinue, cut)
        : undefined,
    [feed, sessionId, cut]
  )
  const continueAt = useSyncExternalStore(subscribe, readContinueAt, readContinueAt)
  // The host publishes no state for a cut it can't schedule and republishes one that ages out.
  const kind = nativeChatUsageLimitAutoContinueKind(state, { schedulable: true, localHost: false })
  // The chat's last options answer predates the cut (the host says no until one exists), so ask
  // now; the host also says no while the journal moves under its read, so ask again at each cursor.
  const asked =
    turnItemId === null ? null : JSON.stringify([turnItemId, journal.cursor?.sequence ?? null])
  const [switchAnswer, setSwitchAnswer] = useState<{
    turnItemId: string
    canSwitch: boolean
  } | null>(null)
  useEffect(() => {
    if (!live || !client || !sessionId || asked === null || turnItemId === null) {
      return
    }
    let current = true
    const answer = (canSwitch: boolean): void => {
      if (current) {
        setSwitchAnswer({ turnItemId, canSwitch })
      }
    }
    callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', { sessionId }).then(
      (result) => answer(result.canSwitchAccount === true),
      () => answer(false)
    )
    return () => {
      current = false
    }
  }, [live, client, sessionId, asked, turnItemId])
  const [cancellingCut, setCancellingCut] = useState<string | null>(null)
  const [failedCut, setFailedCut] = useState<string | null>(null)
  const cancelling = cancellingCut !== null && cancellingCut === turnItemId
  const cancel = useCallback(() => {
    // Read the feed now: the schedule may have changed since this row last rendered.
    if (
      cancelling ||
      !client ||
      !sessionId ||
      cut?.resetsAt === undefined ||
      readState() !== 'scheduled'
    ) {
      return
    }
    const cancelled = cut.turnItemId
    setCancellingCut(cancelled)
    setFailedCut(null)
    void callAgentSession(client, 'agentSession.cancelUsageLimitContinue', {
      sessionId,
      turnItemId: cut.turnItemId,
      resetsAt: cut.resetsAt
    })
      .catch(() => setFailedCut(cancelled))
      .finally(() => setCancellingCut((current) => (current === cancelled ? null : current)))
  }, [cancelling, client, sessionId, cut, readState])
  const { send } = turn
  const continuationCapable = hostSupport?.sendUsageLimitContinuation === true
  const continueNow = useCallback(() => {
    if (turnItemId === null) {
      return
    }
    // A host that knows the cut refuses it once the chat has moved on; older hosts take a plain message.
    void send(
      NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE,
      [],
      undefined,
      undefined,
      undefined,
      continuationCapable ? { usageLimitContinuationOfTurnItemId: turnItemId } : {}
    )
  }, [send, turnItemId, continuationCapable])
  const canCancel = hostSupport?.usageLimitContinueCancel === true
  return useMemo(() => {
    if (turnItemId === null) {
      return null
    }
    return {
      turnItemId,
      autoContinue: kind === 'off' ? null : kind,
      continueAt,
      cancel: kind === 'scheduled' && canCancel ? cancel : null,
      cancelling,
      cancelFailed: failedCut === turnItemId && kind === 'scheduled',
      // A re-ask at a later cursor keeps this cut's last answer, so the row never blanks out.
      canSwitchAccount:
        switchAnswer?.turnItemId === turnItemId ? switchAnswer.canSwitch : live ? undefined : false,
      continueNow
    }
  }, [
    turnItemId,
    kind,
    continueAt,
    canCancel,
    cancel,
    cancelling,
    failedCut,
    switchAnswer,
    live,
    continueNow
  ])
}
