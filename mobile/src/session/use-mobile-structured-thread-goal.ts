import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_OWNED_THREAD_GOAL_CLEAR_COMMAND,
  agentSessionThreadGoalReport
} from '../../../src/shared/agent-session/agent-session-thread-goal-report'
import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../src/shared/agent-session/agent-session-thread-goal-wire'
import { agentSessionWriteNoticeParts } from '../../../src/shared/agent-session/failures/agent-session-refusal-notice'
import type { AgentJournalThreadGoal } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session/options/agent-session-options-result'
import type { StructuredAgentSessionState } from '../../../src/shared/agent-session/structured-agent-session-reducer'
import type { StructuredAgentSessionComposerOptions } from '../../../src/shared/agent-session/view/structured-agent-session-composer'
import { mobileAgentSessionWriteNoticeText } from './agent-session-write-notice-copy'
import type { MobileStructuredAgentSessionArgs } from './mobile-structured-agent-session-contract'
import { mobileStructuredHostClockOffsetMs } from './mobile-structured-host-clock-offset'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'

export type MobileStructuredThreadGoal = {
  /** Scopes the strip's expansion to the conversation. */
  sessionKey: string
  goal: AgentJournalThreadGoal | null
  /** `host`: the host's goal method; `agent`: only the agent's own /goal, which clears and has no pause; null: an older host refuses the phone's changes. */
  changes: 'host' | 'agent' | null
  /** A change is out, or the chat can't take one now. */
  locked: boolean
  /** The running turn, or null when idle; goal time accrues only while one runs. Host clock. */
  runningTurn: { startedAt: number | null } | null
  /** Phone clock minus host clock, for reading goal times on the host's clock. */
  hostClockOffsetMs: number
  /** An agent-owned clear is a message the agent must take, so it waits while the chat works. */
  working: boolean
  /** False when the change was refused or not sent; the error reaches the chat's error banner. */
  change: (change: AgentSessionThreadGoalChange) => Promise<boolean>
}

type ChatSend = (text: string) => Promise<MobileNativeChatSendOutcome>
type GoalCommands = Pick<StructuredAgentSessionComposerOptions, 'setThreadGoalObjective'>

/** The chat's goal and the composer commands that set it; the chat's send is bound after it is built. */
export function useMobileStructuredThreadGoal<TCommands extends object>(
  session: Pick<
    MobileStructuredAgentSessionArgs,
    'hostSupport' | 'enabled' | 'connected' | 'onSendError'
  >,
  state: Pick<StructuredAgentSessionState, 'items' | 'epoch' | 'hostClock'>,
  chat: {
    sessionKey: string
    report: {
      support: AgentSessionOptionsResult['threadGoal']
      reported: AgentSessionOptionsResult['reportedThreadGoal']
    } | null
    turnId: string | null
    /** Phone clock. */
    workingStartedAt: number | null
    working: boolean
    mutate: MobileStructuredAgentMutate
    commands: TCommands
  }
): {
  threadGoal: MobileStructuredThreadGoal | null
  commands: TCommands & GoalCommands
  sendRef: { current: ChatSend }
} {
  const { onSendError } = session
  const { items: journalItems, epoch: journalEpoch } = state
  const { commands, mutate, sessionKey, turnId, workingStartedAt, working } = chat
  const support = chat.report?.support
  const reported = chat.report?.reported
  // The agent-owned clear sends through the chat, which is built after this.
  const sendRef = useRef<ChatSend>(async () => 'rejected')
  const [pendingCount, setPendingCount] = useState(0)
  const report = useMemo(
    () => agentSessionThreadGoalReport({ journalItems, support, reported, journalEpoch }),
    [journalItems, support, reported, journalEpoch]
  )
  const changes: MobileStructuredThreadGoal['changes'] = !report
    ? null
    : !report.hostChanges
      ? 'agent'
      : session.hostSupport?.phoneThreadGoal === true
        ? 'host'
        : null
  const change = useCallback(
    async (next: AgentSessionThreadGoalChange): Promise<boolean> => {
      if (changes === 'agent') {
        return (
          next.kind === 'clear' &&
          (await sendRef.current(AGENT_OWNED_THREAD_GOAL_CLEAR_COMMAND)) !== 'rejected'
        )
      }
      if (changes !== 'host') {
        return false
      }
      setPendingCount((count) => count + 1)
      try {
        const result = await mutate<AgentSessionThreadGoalResult>(
          'agentSession.threadGoal',
          'agentSession.threadGoal',
          { change: next }
        )
        if (result.status === 'unknown') {
          // It may have landed; the strip shows what the host holds once it reports.
          onSendError(
            mobileAgentSessionWriteNoticeText(
              agentSessionWriteNoticeParts({ kind: 'unconfirmed' }, 'goal')
            )
          )
          return true
        }
        return result.status === 'accepted'
      } finally {
        setPendingCount((count) => count - 1)
      }
    },
    [changes, mutate, onSendError]
  )
  const hostClockOffsetMs = mobileStructuredHostClockOffsetMs(state.hostClock)
  const locked = pendingCount > 0 || !session.enabled || !session.connected
  const threadGoal = useMemo<MobileStructuredThreadGoal | null>(
    () =>
      report === null
        ? null
        : {
            sessionKey,
            goal: report.goal,
            changes,
            locked,
            runningTurn:
              turnId === null
                ? null
                : {
                    startedAt:
                      workingStartedAt === null ? null : workingStartedAt - hostClockOffsetMs
                  },
            hostClockOffsetMs,
            working,
            change
          },
    [
      change,
      changes,
      hostClockOffsetMs,
      locked,
      report,
      sessionKey,
      turnId,
      working,
      workingStartedAt
    ]
  )
  const goalCommands = useMemo(
    () =>
      changes === 'host'
        ? {
            ...commands,
            setThreadGoalObjective: (objective: string) => change({ kind: 'set', objective })
          }
        : commands,
    [change, changes, commands]
  )
  return { threadGoal, commands: goalCommands, sendRef }
}

/** Binds the chat's send for the goal's agent-owned clear. */
export function useMobileStructuredThreadGoalSend(
  sendRef: { current: ChatSend },
  send: ChatSend
): void {
  useLayoutEffect(() => {
    sendRef.current = send
  }, [send, sendRef])
}
