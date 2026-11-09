import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { codexStopTarget } from './codex-structured-turn-open-wait'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitFreshInput,
  type StructuredAgentSessionInputAdmission
} from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import { readCodexAutoSandbox } from '../launch/codex-structured-auto-sandbox'
import { codexStructuredPermissionPolicy } from '../../../../shared/codex-permission-policy'
import type { CodexSandboxPolicy } from '../launch/codex-structured-sandbox-policy'

type PermissionHost = {
  connection: Pick<CodexSession['connection'], 'request'>
  permissions?: CodexSession['permissions']
}

/** Prepared outside the host serialize so a configuration request never holds up accepting sends. */
export async function prepareCodexTurnPermission(
  session: PermissionHost,
  mode: AgentChatPermissionChoice,
  signal?: AbortSignal
): Promise<void> {
  const state = session.permissions
  if (!state) {
    return
  }
  const auto =
    mode !== 'auto'
      ? undefined
      : state.acquiredMode === 'auto' && state.launchSandboxIntact
        ? state.acquiredSandbox
        : await waitForPromiseWithSignal(readCodexAutoSandbox(session.connection, state), signal)
  signal?.throwIfAborted()
  state.preparedAuto = auto
  state.preparedMode = mode
}

export function codexPermissionRequiresAcquisition(
  session: PermissionHost,
  mode: AgentChatPermissionChoice
): boolean {
  const state = session.permissions
  return (
    mode === 'auto' &&
    !!state &&
    !state.preparedAuto &&
    !(state.acquiredMode === 'auto' && state.launchSandboxIntact)
  )
}

export function codexTurnPermission(
  session: PermissionHost,
  mode: AgentChatPermissionChoice
): { approvalPolicy?: string; approvalsReviewer?: string; sandboxPolicy?: CodexSandboxPolicy } {
  if (mode === 'own') {
    return {}
  }
  const state = session.permissions
  const { approvalPolicy, approvalsReviewer, sandbox } = codexStructuredPermissionPolicy(mode)
  const sandboxPolicy: CodexSandboxPolicy | undefined =
    sandbox === 'read-only'
      ? { type: 'readOnly' }
      : sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : state?.preparedAuto
  if (mode === 'auto' && codexPermissionRequiresAcquisition(session, mode)) {
    throw new Error('Auto policy requires acquisition')
  }
  if (state && sandboxPolicy && mode !== state.acquiredMode) {
    state.launchSandboxIntact = false
  }
  return { approvalPolicy, approvalsReviewer, ...(sandboxPolicy ? { sandboxPolicy } : {}) }
}

/** Preparation is frame-local; only the final host callback decides and synchronously writes. */
export async function admitCodexTurnPermission(
  session: PermissionHost,
  admit: StructuredAgentSessionAdmitFreshInput | undefined,
  write: (
    permission: ReturnType<typeof codexTurnPermission>,
    body?: AgentJournalMessageItem,
    mode?: AgentChatPermissionChoice
  ) => Extract<StructuredAgentSessionInputAdmission, { kind: 'sent' }>,
  signal?: AbortSignal
): Promise<unknown> {
  let prepared = false
  const enqueue: Parameters<StructuredAgentSessionAdmitFreshInput>[0] = (
    mode,
    _inheritRunning,
    body
  ) => {
    if (mode === 'auto' && !prepared) {
      return { kind: 'prepare' }
    }
    if (
      mode === 'own' &&
      session.permissions &&
      (session.permissions.appliedMode ?? session.permissions.acquiredMode) !== 'own'
    ) {
      return { kind: 'acquire', reason: 'permission' }
    }
    if (codexPermissionRequiresAcquisition(session, mode)) {
      return { kind: 'acquire', reason: 'auto' }
    }
    return write(codexTurnPermission(session, mode), body, mode)
  }
  for (;;) {
    const admission = admit
      ? await admit(enqueue)
      : enqueue(session.permissions?.acquiredMode ?? 'ask', false)
    if (admission.kind === 'prepare') {
      await prepareCodexTurnPermission(session, 'auto', signal)
      prepared = true
      continue
    }
    if (admission.kind === 'acquire') {
      throw new StructuredAgentSessionInputNotAdmitted(undefined, admission.reason)
    }
    return admission.response
  }
}

export function codexNativeResumeRequirement(
  sessions: ReadonlyMap<string, CodexSession>
): NonNullable<StructuredAgentSessionAdapter['permissionModeRequiresAcquisition']> {
  return (sessionId, mode) => {
    const state = sessions.get(sessionId)?.permissions
    return mode === 'own' && !!state && (state.appliedMode ?? state.acquiredMode) !== 'own'
  }
}

export function createCodexPermissionTransition(
  sessions: ReadonlyMap<string, CodexSession>,
  controls: {
    cancelTurn: StructuredAgentSessionAdapter['cancelTurn']
    awaitStoppedRequestEnd: (sessionId: string, stoppedAt: number) => Promise<void>
  }
): NonNullable<StructuredAgentSessionAdapter['settlePermissionTransition']> {
  return async (input) => {
    const session = sessions.get(input.sessionId)
    if (!session || session.ended || session.fence !== input.fence) {
      return false
    }
    if (
      (session.permissions?.appliedMode ?? session.permissions?.acquiredMode) === input.mode ||
      codexStopTarget(session) === null
    ) {
      return true
    }
    const stoppedAt = Date.now()
    const result = await waitForPromiseWithSignal(
      controls.cancelTurn({
        sessionId: input.sessionId,
        fence: input.fence,
        stoppedAt
      }),
      input.signal
    )
    if (!result.cancelled && codexStopTarget(session) !== null) {
      return false
    }
    await waitForPromiseWithSignal(
      controls.awaitStoppedRequestEnd(input.sessionId, stoppedAt),
      input.signal
    )
    return (
      sessions.get(input.sessionId) === session &&
      !session.ended &&
      codexStopTarget(session) === null
    )
  }
}
