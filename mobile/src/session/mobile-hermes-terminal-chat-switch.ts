import { hermesResumeSessionId } from '../../../src/shared/hermes-session-id'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { translate } from '../i18n/mobile-i18n'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileStructuredAgentSession,
  type MobileStructuredAgentLaunchResult
} from './mobile-structured-agent-session-launch'
import {
  launchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch,
  type PendingSessionSelection
} from './pending-session-selection'

function canResumeOnHost(hostCapabilities: readonly string[] | null | undefined): boolean {
  return (
    hostCapabilities?.includes(STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY) === true
  )
}

function chatLock(): string {
  return `hermes-chat:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function openHermesChat(args: {
  client: RpcClient
  worktreeId: string
  providerSessionId?: string
  pendingSelectionRef: { current: PendingSessionSelection | null }
  fetchSessionTabs: () => Promise<void>
}): Promise<MobileStructuredAgentLaunchResult> {
  const lock = chatLock()
  args.pendingSelectionRef.current = launchedSelection(lock, {}, null)
  const created = await createMobileStructuredAgentSession(
    args.client,
    args.worktreeId,
    'hermes',
    args.providerSessionId
      ? { resumeFrom: { providerSessionId: args.providerSessionId } }
      : undefined
  )
  if (created.kind !== 'created') {
    args.pendingSelectionRef.current = withoutUnansweredLaunch(
      args.pendingSelectionRef.current,
      lock
    )
    return created
  }
  args.pendingSelectionRef.current = withLaunchReply(args.pendingSelectionRef.current, lock, {
    sessionId: created.sessionId
  })
  await args.fetchSessionTabs()
  return created
}

function failureText(result: Exclude<MobileStructuredAgentLaunchResult, { kind: 'created' }>): string {
  return result.kind === 'unsupported' ? '' : result.message
}

function toastFailure(
  showToast: (message: string, durationMs?: number) => void,
  message: string
): void {
  triggerError()
  showToast(
    message.trim() ||
      translate('session.hermesTerminalChatSwitch.openFailed', "Couldn't open Hermes chat."),
    1800
  )
}

/** Load the terminal's Hermes session into chat, then close it. No id, or a refused load, opens a new chat and leaves the terminal. */
export async function switchMobileHermesTerminalToChat<Tab extends { id: string }>(args: {
  client: RpcClient
  worktreeId: string
  hostCapabilities: readonly string[] | null | undefined
  providerSessionId: string | null
  terminalTab: Tab
  pendingSelectionRef: { current: PendingSessionSelection | null }
  fetchSessionTabs: () => Promise<void>
  closeTerminalTab: (tab: Tab) => Promise<void> | void
  showToast: (message: string, durationMs?: number) => void
}): Promise<void> {
  const resumeId =
    canResumeOnHost(args.hostCapabilities) && args.providerSessionId
      ? hermesResumeSessionId(args.providerSessionId)
      : null
  if (resumeId) {
    const resumed = await openHermesChat({
      client: args.client,
      worktreeId: args.worktreeId,
      providerSessionId: resumeId,
      pendingSelectionRef: args.pendingSelectionRef,
      fetchSessionTabs: args.fetchSessionTabs
    })
    if (resumed.kind === 'created') {
      await args.closeTerminalTab(args.terminalTab)
      triggerSuccess()
      return
    }
    // An unknown create may already own a session. A refused one has not, so a new chat is safe.
    if (resumed.kind !== 'failed' && resumed.kind !== 'unsupported') {
      toastFailure(args.showToast, failureText(resumed))
      return
    }
  }
  const created = await openHermesChat({
    client: args.client,
    worktreeId: args.worktreeId,
    pendingSelectionRef: args.pendingSelectionRef,
    fetchSessionTabs: args.fetchSessionTabs
  })
  if (created.kind === 'created') {
    triggerSuccess()
    return
  }
  toastFailure(args.showToast, failureText(created))
}

type HermesSheetController = {
  client: RpcClient | null
  worktreeId: string
  hostCapabilities: readonly string[] | null | undefined
  terminals: readonly { handle: string; agentIdentity?: string }[]
  pendingSelectionRef: { current: PendingSessionSelection | null }
  fetchSessionTabs: () => Promise<void>
}

/** Keep the session sheet under its line limit. The row still reads the terminal's hook id. */
export function hermesTerminalActionFields<Tab extends { id: string }>(args: {
  controller: HermesSheetController
  sessionTabs: readonly Tab[]
  handle: string | null | undefined
  closeTerminalTab: (tab: Tab) => Promise<void> | void
  showToast: (message: string, durationMs?: number) => void
}): {
  hostAgentIdentity: string | undefined
  hermesResumeSupported: boolean
  onHermesTerminalChat: (request: { tabId: string; providerSessionId: string | null }) => void
} {
  const { controller } = args
  return {
    hostAgentIdentity: controller.terminals.find((terminal) => terminal.handle === args.handle)
      ?.agentIdentity,
    hermesResumeSupported: canResumeOnHost(controller.hostCapabilities),
    onHermesTerminalChat: ({ tabId, providerSessionId }) => {
      const tab = args.sessionTabs.find((candidate) => candidate.id === tabId)
      if (!tab || !controller.client) {
        return
      }
      void switchMobileHermesTerminalToChat({
        client: controller.client,
        worktreeId: controller.worktreeId,
        hostCapabilities: controller.hostCapabilities,
        providerSessionId,
        terminalTab: tab,
        pendingSelectionRef: controller.pendingSelectionRef,
        fetchSessionTabs: controller.fetchSessionTabs,
        closeTerminalTab: args.closeTerminalTab,
        showToast: args.showToast
      })
    }
  }
}
