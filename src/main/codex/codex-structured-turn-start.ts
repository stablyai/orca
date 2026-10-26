import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitFreshInput
} from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import { turnInputFor } from './codex-structured-message-options'
import { reportedCodexPermissionMode } from './codex-structured-thread-open'
import { admitCodexTurnPermission } from './codex-structured-turn-permission'
import type { CodexSkillReport } from './codex-structured-skill-report'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type {
  AgentJournalMessageItem,
  AgentJournalTurnJoin
} from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { readCodexTurnId } from './codex-structured-thread-facts'
import { codexTurnRequestOptions } from './codex-structured-service-tier'
import type { CodexSession } from './codex-structured-session-state'
import {
  codexRunningOrOpeningTurn,
  type CodexTurnOpenWaits
} from './codex-structured-turn-open-wait'
import {
  codexAnsweredTurn,
  codexDispatchRejection,
  codexTurnEndRejection
} from './codex-structured-turn-end-settlement'

/** Allowlist turn overrides so saved options cannot replace the thread's permission policy. */
const CODEX_TURN_OPTION_KEYS = new Set(['model', 'effort', 'personality', 'serviceTier'])

export function isCodexTurnOptionKey(key: string): boolean {
  return CODEX_TURN_OPTION_KEYS.has(key)
}

function checkDispatchAuthority(
  host: CodexTurnHost,
  id: string,
  signal?: AbortSignal,
  isCurrent?: () => boolean
): void {
  if (isCurrent?.() === false) {
    host.dispatchEchoes.disarm(id)
    throw new StructuredAgentSessionInputNotAdmitted({
      state: 'rejected',
      ...codexDispatchRejection(
        agentSessionFailureFact('providerExited', { neverReachedAgent: true })
      )
    })
  }
  if (signal?.aborted) {
    host.dispatchEchoes.disarm(id)
    throw new StructuredAgentSessionInputNotAdmitted({
      state: 'rejected',
      ...codexDispatchRejection(agentSessionFailureFact('cancelled'))
    })
  }
}

export type CodexTurnHost = {
  account?: AgentSessionAccountKind
  skillReport?: Pick<CodexSkillReport, 'hasSkillPath'>
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  permissions?: CodexSession['permissions']
  options: Map<string, string>
  appliedTurnOptions?: Readonly<Record<string, string>>
  appliedSettings?: CodexSession['appliedSettings']
  reportedOptions?: CodexSession['reportedOptions']
  catalogAccess?: CodexSession['catalogAccess']
  dispatchEchoes: CodexDispatchEchoes
  activeTurnIds?: ReadonlySet<string>
  /** Running turns whose interrupt Codex already answered: aborted, so never steered. */
  abortedTurnIds?: ReadonlySet<string>
  turnOpenWaits: Pick<CodexTurnOpenWaits, 'wait'>
}

/** Explicit steering avoids pre-0.148 turn/start replies naming nonexistent turns; overrides wait for a start. */
async function steerCodexTurn(
  host: CodexTurnHost,
  expectedTurnId: string,
  input: {
    clientMessageId: string
    body: AgentJournalMessageItem
    timeoutMs?: number
    signal?: AbortSignal
    isCurrent?: () => boolean
    onReply?: () => void
  }
): Promise<{ turnId: string; via: 'steer' } | null> {
  try {
    checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    const answer = await host.connection.request(
      'turn/steer',
      {
        threadId: host.threadId,
        expectedTurnId,
        clientUserMessageId: input.clientMessageId,
        input: turnInputFor(host, input.body)
      },
      { timeoutMs: input.timeoutMs, onReply: input.onReply }
    )
    return { turnId: readCodexTurnId(answer) ?? expectedTurnId, via: 'steer' }
  } catch (error) {
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      return null
    }
    throw error
  }
}

/** false means correlation capacity refused the send before writing; null turnId means an unnamed answer. */
export async function startCodexTurn(
  host: CodexTurnHost,
  input: {
    clientMessageId: string
    body: AgentJournalMessageItem
    requestedAt?: number
    timeoutMs?: number
    turnOptions?: Readonly<Record<string, string>>
    signal?: AbortSignal
    isCurrent?: () => boolean
    admitFreshInput?: StructuredAgentSessionAdmitFreshInput
    onReply?: () => void
  }
): Promise<{ turnId: string | null; via: AgentJournalTurnJoin } | false> {
  // Arm before writing: echoes and turn/started can arrive before the reply.
  if (!host.dispatchEchoes.arm(input.clientMessageId, input.requestedAt)) {
    return false
  }
  // Interrupt-acknowledged turns cannot take steers while awaiting completion.
  const steerable = (turnId: string | null | undefined): turnId is string =>
    typeof turnId === 'string' && turnId !== '' && !host.abortedTurnIds?.has(turnId)
  let runningTurnId: string | null
  try {
    runningTurnId = await codexRunningOrOpeningTurn(host, input.signal)
  } catch (error) {
    host.dispatchEchoes.disarm(input.clientMessageId)
    checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    throw error
  }
  let steered = steerable(runningTurnId) ? await steerCodexTurn(host, runningTurnId, input) : null
  // Retry steering once if another turn opened during the refused request.
  const runningSince = steered ? undefined : [...(host.activeTurnIds ?? [])].at(-1)
  if (steerable(runningSince) && runningSince !== runningTurnId) {
    steered = await steerCodexTurn(host, runningSince, input)
  }
  if (steered) {
    return steered
  }
  const previousApplied = host.appliedTurnOptions
  const previousOptions = input.turnOptions ? new Map(host.options) : null
  let enqueued = false
  let discardSettingsAttempt: (() => void) | undefined
  const enqueue = (
    permission: Parameters<Parameters<typeof admitCodexTurnPermission>[2]>[0],
    body = input.body
  ) => {
    checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    if (input.turnOptions) {
      host.options.clear()
      for (const [key, value] of Object.entries(input.turnOptions)) {
        host.options.set(key, value)
      }
    }
    host.appliedTurnOptions = input.turnOptions ?? Object.fromEntries(host.options)
    const requested = codexTurnRequestOptions(host)
    discardSettingsAttempt = host.appliedSettings?.attempt(requested)
    enqueued = true
    return {
      kind: 'sent' as const,
      response: host.connection
        .request(
          'turn/start',
          {
            threadId: host.threadId,
            clientUserMessageId: input.clientMessageId,
            input: turnInputFor(host, body),
            ...permission,
            ...requested
          },
          { timeoutMs: input.timeoutMs, onReply: input.onReply }
        )
        .then((answer) => {
          const applied = reportedCodexPermissionMode({
            ...permission,
            sandbox: permission.sandboxPolicy
          })
          // Successful fresh-turn policy is applied evidence, not a provider readback.
          if (applied && host.reportedOptions) {
            host.reportedOptions.reportedPermissionMode = applied
          }
          return answer
        })
    }
  }
  let answer: unknown
  try {
    answer = await admitCodexTurnPermission(host, input.admitFreshInput, enqueue, input.signal)
  } catch (error) {
    if (!enqueued) {
      host.dispatchEchoes.disarm(input.clientMessageId)
      checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    }
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      discardSettingsAttempt?.()
    }
    if (
      previousOptions &&
      (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error))
    ) {
      host.appliedTurnOptions = previousApplied
      host.options.clear()
      for (const [key, value] of previousOptions) {
        host.options.set(key, value)
      }
    }
    throw error
  }
  return { turnId: readCodexTurnId(answer), via: 'start' }
}

/** Replies establish admission; exact echoes establish identity. Timeouts cannot disprove delivery. */
export async function dispatchCodexTurn(
  session: CodexTurnHost,
  input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    requestedAt?: number
    turnOptions?: Readonly<Record<string, string>>
    signal?: AbortSignal
    isCurrent?: () => boolean
    admitFreshInput?: StructuredAgentSessionAdmitFreshInput
  },
  timeoutMs: number | undefined
): Promise<AgentSessionDispatchOutcome> {
  let answer: { turnId: string | null; via: AgentJournalTurnJoin } | false
  // Capture wire order at reply receipt, before async continuations run.
  let answeredAt: number | undefined
  const onReply = (): void => {
    answeredAt = session.dispatchEchoes.tick()
  }
  try {
    answer = await startCodexTurn(session, { ...input, timeoutMs, onReply })
  } catch (error) {
    if (error instanceof StructuredAgentSessionInputNotAdmitted) {
      throw error
    }
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      // Codex answered and declined, so no echo for this write can arrive.
      session.dispatchEchoes.disarm(input.clientMessageId)
      // Declined requests recorded no input; carried stopped messages remain owed.
      return {
        state: 'rejected',
        ...codexDispatchRejection(
          agentSessionFailureFact('providerRejected', {
            detail: providerDiagnosticOf(error),
            neverReachedAgent: true
          })
        )
      }
    }
    // Transport failure may follow a successful write; keep correlation for a later echo.
    session.dispatchEchoes.answered(
      input.clientMessageId,
      answeredAt ?? session.dispatchEchoes.tick()
    )
    throw error
  }
  if (!answer) {
    return { state: 'rejected', ...codexDispatchRejection(agentSessionFailureFact('queueFull')) }
  }
  // An answer read after the turn it names already ended is settled by that end.
  if (!answer.turnId) {
    session.dispatchEchoes.answered(
      input.clientMessageId,
      answeredAt ?? session.dispatchEchoes.tick()
    )
  }
  const endedFirst = answer.turnId
    ? session.dispatchEchoes.bindTurn(
        input.clientMessageId,
        session.threadId,
        answer.turnId,
        answer.via,
        answeredAt
      )
    : null
  const rejection = endedFirst ? codexTurnEndRejection(endedFirst, session.account) : null
  return rejection && answer.turnId
    ? {
        state: 'rejected',
        ...codexAnsweredTurn(session, input.sessionId, answer.turnId, answer.via),
        ...rejection
      }
    : { state: 'admitted', ranOptions: codexRanOptions(session) }
}

/** Steers retain running-turn options; starts use request overrides over thread defaults. */
function codexRanOptions(session: CodexTurnHost): Record<string, string> {
  const requested = codexTurnRequestOptions(session)
  const thread = session.reportedOptions ?? {}
  const model = requested.model ?? thread.model
  const effort = requested.effort ?? (model === thread.model ? thread.effort : undefined)
  const { serviceTier } = requested
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {})
  }
}
