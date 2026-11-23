import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  latestNativeChatUsageLimitCut,
  NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE
} from '../../../../../src/shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import {
  nativeChatUsageLimitAutoContinueKind,
  usageLimitContinueAtForCut,
  usageLimitContinueResetForCut,
  usageLimitContinueStateForCut,
  type NativeChatUsageLimitAutoContinueKind
} from '../../../../../src/shared/native-chat/transcript/continuation/native-chat-usage-limit-auto-continue'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCardSubmission } from '../../../../../src/shared/agent-session/requests/agent-session-queued-submission'
import type { AgentSessionOptionsResult } from '../../../../../src/shared/agent-session/options/protocol/agent-session-options-result'
import type { AgentJournalCursor } from '../../../../../src/shared/agent-session/journal/agent-session-journal-identity'
import type { BotBackupModelEntry } from '../../../../../src/shared/bots/bot-backup-models'
import { folderWorkspaceKey } from '../../../../../src/shared/workspace/identity/workspace-scope'
import { botsListRead } from '../../../bots/host-bots-operations'
import { botBackupStatusRead, botBackupSwitch } from '../../../bots/bot-sheet-operations'
import { botAgentLabel } from '../../../bots/mobile-bot-sheet-copy'
import { mobileStructuredSessionStatusFeed } from '../agent-session/mobile-structured-session-status-feed'
import { callAgentSession } from '../agent-session/mobile-structured-agent-session-rpc'
import type {
  MobileStructuredAgentSessionArgs,
  StructuredMobileSession
} from '../agent-session/mobile-structured-agent-session-contract'

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
  /** Bot backup-model failover state for this cut when the session belongs to a bot. */
  backupState?: 'switching' | 'ask-backup' | 'backups-exhausted'
  backupResetsAt?: number
  backupSwitchLabel?: string
  backupSwitching?: boolean
  switchToBackup?: (() => void) | null
}

const noSubscription = (): (() => void) => () => {}

export function useMobileNativeChatUsageLimit(
  chat: Pick<
    MobileStructuredAgentSessionArgs,
    'client' | 'sessionId' | 'sourceIdentity' | 'enabled' | 'connected' | 'hostSupport'
  >,
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalCardSubmission[]
    cursor?: AgentJournalCursor | null
  },
  /** Busy: working or sending, when the cut is not the chat's last word. */
  turn: { busy: boolean; send: StructuredMobileSession['sendWithOutcome'] }
): MobileNativeChatUsageLimit | null {
  const { client, sessionId, hostSupport } = chat
  const live = chat.enabled && chat.connected
  const { items, submissions } = journal
  // While the chat works or sends no cut is actionable, so skip the transcript scan per chunk.
  const read = useMemo(
    () => (turn.busy ? null : latestNativeChatUsageLimitCut(items, submissions)),
    [turn.busy, items, submissions]
  )
  const turnItemId = read?.turnItemId ?? null
  // The host alone continues the chat at its reset, or after an account switch when the reset is
  // unknown; the phone only shows and cancels that.
  const feed =
    live &&
    client &&
    sessionId &&
    turnItemId !== null &&
    hostSupport?.statusFeed === true &&
    hostSupport.usageLimitAutoContinue
      ? mobileStructuredSessionStatusFeed(client)
      : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readReset = useCallback(
    () =>
      feed && sessionId
        ? usageLimitContinueResetForCut(feed.getSnapshot().get(sessionId)?.usageLimitContinue, read)
        : read?.resetsAt,
    [feed, sessionId, read]
  )
  const resetsAt = useSyncExternalStore(subscribe, readReset, readReset)
  const cut = useMemo(
    () => (read && resetsAt !== read.resetsAt ? { ...read, resetsAt } : read),
    [read, resetsAt]
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
  const readBackupState = useCallback(() => {
    if (!feed || !sessionId || turnItemId === null) {
      return undefined
    }
    const published = feed.getSnapshot().get(sessionId)?.usageLimitContinue
    return published?.turnItemId === turnItemId ? published.backupState : undefined
  }, [feed, sessionId, turnItemId])
  const backupState = useSyncExternalStore(subscribe, readBackupState, readBackupState)
  const readBackupResetsAt = useCallback(() => {
    if (!feed || !sessionId || turnItemId === null) {
      return undefined
    }
    const published = feed.getSnapshot().get(sessionId)?.usageLimitContinue
    return published?.turnItemId === turnItemId ? published.backupResetsAt : undefined
  }, [feed, sessionId, turnItemId])
  const backupResetsAt = useSyncExternalStore(subscribe, readBackupResetsAt, readBackupResetsAt)
  const [backupOffer, setBackupOffer] = useState<{
    turnItemId: string
    botId: string
    target: BotBackupModelEntry
  } | null>(null)
  const [backupSwitchingCut, setBackupSwitchingCut] = useState<string | null>(null)
  useEffect(() => {
    if (!live || !client || !sessionId || !turnItemId || backupState !== 'ask-backup') {
      return
    }
    let current = true
    void (async () => {
      try {
        const listed = botsListRead.interpret(await botsListRead.request(client, {}))
        if (!current || listed.kind !== 'bots') {
          return
        }
        const matched = listed.value.bots.find(
          (bot) =>
            bot.chatSessionId === sessionId ||
            (chat.sourceIdentity !== undefined &&
              chat.sourceIdentity.includes(folderWorkspaceKey(bot.folderWorkspaceId)))
        )
        if (!matched) {
          return
        }
        const status = botBackupStatusRead.interpret(
          await botBackupStatusRead.request(
            client,
            { botId: matched.id },
            { failWhenDisconnected: true }
          )
        )
        const ready =
          status.entries.find((entry) => entry.state === 'ready')?.entry ??
          matched.backupModels?.order[0]
        if (current && ready) {
          setBackupOffer({ turnItemId, botId: matched.id, target: ready })
        }
      } catch {
        // Ignore when the host does not offer backup status.
      }
    })()
    return () => {
      current = false
    }
  }, [live, client, sessionId, turnItemId, backupState, chat.sourceIdentity])
  const activeOffer =
    backupState === 'ask-backup' && backupOffer?.turnItemId === turnItemId ? backupOffer : null
  const backupSwitching = backupSwitchingCut !== null && backupSwitchingCut === turnItemId
  const switchToBackup = useCallback(() => {
    if (!client || !sessionId || !activeOffer || backupSwitching) {
      return
    }
    const cutId = activeOffer.turnItemId
    setBackupSwitchingCut(cutId)
    void botBackupSwitch
      .request(
        client,
        {
          botId: activeOffer.botId,
          sessionId,
          turnItemId: cutId,
          target: activeOffer.target
        },
        { failWhenDisconnected: true }
      )
      .catch(() => {})
      .finally(() => setBackupSwitchingCut((current) => (current === cutId ? null : current)))
  }, [client, sessionId, activeOffer, backupSwitching])
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
      continueNow,
      ...(backupState ? { backupState } : {}),
      ...(backupResetsAt !== undefined ? { backupResetsAt } : {}),
      ...(activeOffer
        ? {
            backupSwitchLabel: activeOffer.target.model ?? botAgentLabel(activeOffer.target.agent),
            backupSwitching,
            switchToBackup
          }
        : {})
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
    continueNow,
    backupState,
    backupResetsAt,
    activeOffer,
    backupSwitching,
    switchToBackup
  ])
}
