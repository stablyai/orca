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
import { AGENT_SESSION_PHONE_THREAD_GOAL_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/agent-session-runtime-capabilities'
import { useRouteRelaysCapability } from '../worktree/workspace-server-context'

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
  /** As `locked`; an agent-owned clear is also a message the agent must take, so it waits while the chat works. */
  clearLocked: boolean
  /** False when the change was refused or not sent; the error reaches the chat's error banner. */
  change: (change: AgentSessionThreadGoalChange) => Promise<boolean>
}

type ChatSend = (text: string) => Promise<MobileNativeChatSendOutcome>
type GoalCommands = Pick<StructuredAgentSessionComposerOptions, 'changeThreadGoal'>

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
  // One hook serves every chat tab, so each conversation counts only its own changes.
  const [pending, setPending] = useState<Readonly<Record<string, number>>>({})
  const report = useMemo(
    () => agentSessionThreadGoalReport({ journalItems, support, reported, journalEpoch }),
    [journalItems, support, reported, journalEpoch]
  )
  const relayed = useRouteRelaysCapability(AGENT_SESSION_PHONE_THREAD_GOAL_RUNTIME_CAPABILITY)
  const changes: MobileStructuredThreadGoal['changes'] = !report
    ? null
    : !report.hostChanges
      ? 'agent'
      : session.hostSupport?.phoneThreadGoal === true && relayed
        ? 'host'
        : null
  const change = useCallback(
    async (next: AgentSessionThreadGoalChange): Promise<boolean> => {
      if (changes === null || (changes === 'agent' && next.kind !== 'clear')) {
        return false
      }
      const count = (by: number) =>
        setPending(({ [sessionKey]: mine = 0, ...others }) =>
          mine + by > 0 ? { ...others, [sessionKey]: mine + by } : others
        )
      count(1)
      try {
        if (changes === 'agent') {
          return (await sendRef.current(AGENT_OWNED_THREAD_GOAL_CLEAR_COMMAND)) !== 'rejected'
        }
        const result = await mutate<AgentSessionThreadGoalResult>(
          'agentSession.threadGoal',
          'agentSession.threadGoal',
          { change: next }
        )
        if (result.status === 'unknown') {
          // As on desktop, an objective it may not hold stays in the composer; the strip shows what landed.
          onSendError(
            mobileAgentSessionWriteNoticeText(
              agentSessionWriteNoticeParts({ kind: 'unconfirmed' }, 'goal')
            )
          )
        }
        return result.status === 'accepted'
      } finally {
        count(-1)
      }
    },
    [changes, mutate, onSendError, sessionKey]
  )
  const hostClockOffsetMs = mobileStructuredHostClockOffsetMs(state.hostClock)
  const locked = (pending[sessionKey] ?? 0) > 0 || !session.enabled || !session.connected
  // The report is rebuilt on every journal append; the strip changes only when its goal does.
  const hasReport = report !== null
  const goal = report?.goal ?? null
  const clearLocked = locked || (changes === 'agent' && working)
  const threadGoal = useMemo<MobileStructuredThreadGoal | null>(
    () =>
      hasReport
        ? {
            sessionKey,
            goal,
            changes,
            locked,
            clearLocked,
            runningTurn:
              turnId === null
                ? null
                : {
                    startedAt:
                      workingStartedAt === null ? null : workingStartedAt - hostClockOffsetMs
                  },
            hostClockOffsetMs,
            change
          }
        : null,
    [
      change,
      changes,
      clearLocked,
      goal,
      hasReport,
      hostClockOffsetMs,
      locked,
      sessionKey,
      turnId,
      workingStartedAt
    ]
  )
  const goalCommands = useMemo(
    () => ({ ...commands, changeThreadGoal: changes === 'host' ? change : undefined }),
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
