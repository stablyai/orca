import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitFreshInput,
  type StructuredAgentSessionInputAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import type { AgentChatPermissionChoice } from '../../shared/agent-chat-permission-mode'
import type { CodexSession } from './codex-structured-session-state'
import { readCodexAutoSandbox } from './codex-structured-auto-sandbox'
import { codexStructuredPermissionPolicy } from '../../shared/codex-permission-policy'
import type { CodexSandboxPolicy } from './codex-structured-sandbox-policy'

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
  mode: AgentChatPermissionChoice,
  inheritRunning = false
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
  // Unknown Auto retains the running child's grant until safe reacquisition; never invent access.
  if (mode === 'auto' && codexPermissionRequiresAcquisition(session, mode)) {
    if (inheritRunning) {
      return {}
    }
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
    body?: AgentJournalMessageItem
  ) => Extract<StructuredAgentSessionInputAdmission, { kind: 'sent' }>,
  signal?: AbortSignal
): Promise<unknown> {
  let prepared = false
  const enqueue: Parameters<StructuredAgentSessionAdmitFreshInput>[0] = (
    mode,
    inheritRunning,
    body
  ) => {
    if (mode === 'auto' && !prepared) {
      return { kind: 'prepare' }
    }
    if (codexPermissionRequiresAcquisition(session, mode) && !inheritRunning) {
      return { kind: 'acquire' }
    }
    return write(codexTurnPermission(session, mode, inheritRunning), body)
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
      throw new StructuredAgentSessionInputNotAdmitted()
    }
    return admission.response
  }
}
