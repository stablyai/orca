import {
  buildMobileQuickCommandLaunch,
  type MobileQuickCommandLaunch
} from '../terminal/quick-commands'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { sessionTabCreateTerminal } from './mobile-session-write-operations'
import { triggerSuccess, triggerError } from '../platform/haptics'
import { buildTerminalSendParams } from '../terminal/terminal-send-request'
import { terminalRecordsEqual } from './mobile-terminal-records'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import type { MobileSessionTab, Terminal } from './mobile-session-route-types'
import type { MobileSessionAttachmentsModel } from './use-mobile-session-attachments'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { createMobileStructuredAgentSession } from './mobile-structured-agent-session-launch'
import { launchAgentInExistingWorkspace } from './mobile-existing-agent-launch'
import { AGENT_PROMPT_NOT_SENT_MESSAGE } from './pr-ai-triage-launch'
import { launchedSelection, withoutPendingHandle } from './pending-session-selection'
import { placeCreatedSessionTab } from '../../../src/shared/session-tab-placement'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'

const NOTES_NOT_SENT_MESSAGE = "The agent started, but the notes weren't sent."

/** Agent launches that `agent.launch` can carry: bare, or with a prompt to submit. A shell command
 *  or an unsent draft stays a plain terminal. */
function launchesThroughHost(options: MobileQuickCommandLaunch['options'] | undefined): boolean {
  return options?.startupCommand === undefined && options?.enter !== false
}

export function useMobileSessionTerminalCreateActions(scope: MobileSessionAttachmentsModel) {
  const {
    worktreeId,
    client,
    hostCapabilities,
    connState,
    setTerminals,
    terminalsRef,
    setSessionTabs,
    defaultTerminalHandlesToLiveInput,
    setActiveHandle,
    activeSessionTabId,
    setActiveSessionTabId,
    setCreating,
    creatingTerminalRef,
    creatingBrowser,
    creatingMarkdown,
    setCreateError,
    deviceTokenRef,
    initializedHandlesRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingSelectionRef,
    scheduleDelayedAction,
    showToast,
    unsubscribeTerminal,
    subscribeToTerminal,
    fetchSessionTabs
  } = scope
  async function handleCreateTerminal(
    agent?: MobileNewTabAgentOption['agent'],
    options?: MobileQuickCommandLaunch['options'] & {
      onPromptSent?: () => void
      errorToast?: string
    }
  ) {
    if (!client || creatingTerminalRef.current) {
      return
    }
    creatingTerminalRef.current = true

    setCreating(true)
    setCreateError('')

    // Why: idempotency key so a transport retry (reconnect replay) resolves to the same terminal, not a duplicate; kept compact (no worktree id) for the schema length cap.
    const clientMutationId = `mobile-create:${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`

    // Why: the host names the real cause (pty exhaustion, disabled agent, unresolved worktree);
    // collapsing every failure to 'Failed to create terminal' left the phone undiagnosable.
    function reportCreateFailure(hostReason: string): void {
      const reason = hostReason.trim() || options?.errorToast || 'Failed to create terminal'
      setCreateError(reason)
      // Why: the inline error renders only in an empty session; beside open tabs only a toast is seen.
      triggerError()
      showToast(options?.errorToast ?? reason, 1800)
    }

    try {
      if (agent && launchesThroughHost(options)) {
        const prompt = options?.agentPrompt ?? options?.initialPrompt
        const launched = await launchAgentInExistingWorkspace({
          client,
          hostCapabilities,
          worktreeId,
          agent,
          ...(prompt?.trim() ? { prompt: { text: prompt, delivery: 'submit' as const } } : {}),
          ...(options?.agentPrompt
            ? { launchSource: 'quick_command' }
            : options?.initialPrompt
              ? { launchSource: 'diff_notes_send' }
              : {})
        })
        if (launched.kind === 'launched') {
          const { outcome, warning } = launched.result
          pendingSelectionRef.current = launchedSelection(
            outcome.kind === 'structured'
              ? { sessionId: outcome.sessionId }
              : { handle: outcome.handle }
          )
          // Refresh if the reply beats its published tab frame.
          scheduleDelayedAction(() => void fetchSessionTabs(), 500)
          if (launched.promptDelivered === false) {
            triggerError()
            showToast(
              options?.initialPrompt ? NOTES_NOT_SENT_MESSAGE : AGENT_PROMPT_NOT_SENT_MESSAGE,
              2400
            )
          } else if (launched.promptDelivered && options?.initialPrompt) {
            triggerSuccess()
            showToast(options.successToast ?? 'Notes sent')
            options.onPromptSent?.()
          } else if (warning?.trim()) {
            showToast(warning.trim(), 2400)
          }
          return
        }
        if (launched.kind === 'failed') {
          reportCreateFailure(launched.message)
          return
        }
        if (launched.kind === 'unknown') {
          // Never start a second agent when the first may already be running.
          setCreateError(launched.message)
          triggerError()
          showToast(launched.message, 1800)
          return
        }
        // COMPAT(agent.launch.v2): hosts before v1.4.206 keep the paths below; remove once none remain.
      }
      // Bare structured-provider launches follow host createSupport; prompted launches keep their startup semantics.
      if (isAgentSessionHandleProvider(agent) && options === undefined) {
        const structured = await createMobileStructuredAgentSession(client, worktreeId, agent)
        if (structured.kind === 'created') {
          const previous = activeHandleRef.current
          if (previous) {
            unsubscribeTerminal(previous)
            initializedHandlesRef.current.delete(previous)
          }
          // Found by session in the next snapshot, never by a predicted tab id.
          pendingSelectionRef.current = launchedSelection({ sessionId: structured.sessionId })
          activeSessionTabTypeRef.current = 'agent-session'
          activeHandleRef.current = null
          setActiveHandle(null)
          // Refresh if the create response beats its published tab frame.
          scheduleDelayedAction(() => void fetchSessionTabs(), 500)
          return
        }
        if (structured.kind === 'unknown') {
          // Never create a legacy sibling when the host may already have committed.
          setCreateError(structured.message)
          triggerError()
          showToast(structured.message, 1800)
          return
        }
      }
      const afterTabId = activeSessionTabId ?? undefined
      const hostSupportsGroupedPlacement =
        hostCapabilities?.includes(SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY) === true
      const response = await sessionTabCreateTerminal.request(client, {
        worktree: `id:${worktreeId}`,
        afterTabId,
        clientMutationId,
        ...(options?.startupCommand ? { command: options.startupCommand } : {}),
        ...(options?.startupCommandDelivery
          ? { startupCommandDelivery: options.startupCommandDelivery }
          : {}),
        ...(options?.agentPrompt ? { agentPrompt: options.agentPrompt } : {}),
        ...(agent ? { agent } : {}),
        activate: false,
        select: true,
        navigation: 'caller'
      })
      // Why interpret here rather than branching: a refused create throws the host's message,
      // which the catch below reports exactly as the old `else` branch did.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
      const created = sessionTabCreateTerminal.interpret(response) as Extract<
        MobileSessionTab,
        { type: 'terminal' }
      >
      // Why: unsubscribe the old terminal so the server restores its desktop dims; otherwise its restore timer is never set.
      const prev = activeHandleRef.current
      if (prev) {
        unsubscribeTerminal(prev)
        initializedHandlesRef.current.delete(prev)
      }
      pendingSelectionRef.current = { kind: 'tab', tabId: created.id }
      activeSessionTabTypeRef.current = 'terminal'
      setActiveSessionTabId(created.id)
      // An older headed host places after the parent while an older headless host places after the
      // leaf. Without the capability, wait for the host snapshot instead of guessing.
      if (hostSupportsGroupedPlacement) {
        setSessionTabs((prev) => {
          if (prev.some((tab) => tab.id === created.id)) {
            return prev
          }
          return placeCreatedSessionTab(prev, { ...created, isActive: true }, afterTabId, {
            afterParentGroup: true
          })
        })
      }
      if (typeof created.terminal === 'string') {
        const createdHandle = created.terminal
        defaultTerminalHandlesToLiveInput([createdHandle])
        // Why: snapshots lag the create RPC; without this marker applySessionTabs reverts the active handle, blanking the new pane.
        pendingSelectionRef.current = { kind: 'terminal', handle: createdHandle, tabId: created.id }
        activeHandleRef.current = createdHandle
        setActiveHandle(createdHandle)
        setTerminals((prev) => {
          const existing = prev.find((terminal) => terminal.handle === createdHandle)
          const createdTerminal: Terminal = {
            handle: createdHandle,
            title: created.title || existing?.title || 'Terminal',
            terminalTheme: created.terminalTheme ?? existing?.terminalTheme,
            isActive: true
          }
          if (existing) {
            const next = prev.map((terminal) =>
              terminal.handle === createdHandle ? { ...terminal, ...createdTerminal } : terminal
            )
            terminalsRef.current = next
            return terminalRecordsEqual(prev, next) ? prev : next
          }
          const next = [...prev, createdTerminal]
          terminalsRef.current = next
          return next
        })
        subscribeToTerminal(createdHandle)
        if (options?.initialPrompt?.trim()) {
          void client
            .sendRequest(
              'terminal.send',
              buildTerminalSendParams({
                terminal: createdHandle,
                text: options.initialPrompt,
                enter: options.enter !== false,
                deviceToken: deviceTokenRef.current
              })
            )
            .then((sendResponse) => {
              if (!sendResponse.ok) {
                throw new Error(
                  (sendResponse as RpcFailure).error.message || 'Failed to send notes'
                )
              }
              const result = (sendResponse as RpcSuccess).result as {
                send?: { accepted?: boolean }
              }
              if (result.send?.accepted === false) {
                throw new Error('Terminal input is locked by another client.')
              }
              triggerSuccess()
              showToast(options.successToast ?? 'Notes sent')
              options.onPromptSent?.()
            })
            .catch((err) => {
              triggerError()
              showToast(
                options.errorToast ?? (err instanceof Error ? err.message : "Couldn't send notes"),
                1800
              )
            })
        } else if (options?.successToast) {
          triggerSuccess()
          showToast(options.successToast)
        }
      } else {
        // Why: a prior pending handle must not outlive a create that returned no terminal; web-ready subscribe gates on this ref.
        pendingSelectionRef.current = withoutPendingHandle(pendingSelectionRef.current)
        activeHandleRef.current = null
        setActiveHandle(null)
      }
      scheduleDelayedAction(() => void fetchSessionTabs(), 500)
    } catch (error) {
      reportCreateFailure(error instanceof Error ? error.message : '')
    } finally {
      creatingTerminalRef.current = false
      setCreating(false)
    }
  }

  // Quick commands spawn a fresh terminal tab, mirroring desktop's
  // run-quick-command-in-new-tab: agent prompts and runnable terminal commands
  // use the host's shell-ready startup path; insert-only commands stay drafts.
  function launchQuickCommand(command: TerminalQuickCommand): boolean {
    if (
      !client ||
      connState !== 'connected' ||
      creatingTerminalRef.current ||
      creatingBrowser ||
      creatingMarkdown
    ) {
      return false
    }
    const launch = buildMobileQuickCommandLaunch(command)
    if (!launch) {
      triggerError()
      showToast('Edit this quick command before running it', 1800)
      return false
    }
    const label = command.label.trim() || 'Quick command'
    void handleCreateTerminal(launch.agent, {
      ...launch.options,
      errorToast: `Couldn't run ${label}`
    })
    return true
  }
  return {
    handleCreateTerminal,
    launchQuickCommand
  }
}

export type MobileSessionTerminalCreateActionsModel = MobileSessionAttachmentsModel &
  ReturnType<typeof useMobileSessionTerminalCreateActions>
