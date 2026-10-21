import type { MobileQuickCommandLaunch } from '../terminal/quick-commands'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { sessionTabCreateTerminal } from './mobile-session-write-operations'
import { triggerSuccess, triggerError } from '../platform/haptics'
import { buildTerminalSendParams } from '../terminal/terminal-send-request'
import { terminalRecordsEqual } from './mobile-terminal-records'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import {
  hostSupportsMobileChatFork,
  mobileChatForkCreateReplyMessage,
  mobileChatForkRequestFailureMessage
} from './mobile-chat-fork-create-feedback'
import type { MobileSessionTab, Terminal } from './mobile-session-route-types'
import type { MobileSessionAttachmentsModel } from './use-mobile-session-attachments'
import { useMobileTerminalCreateRouteOwner } from './use-mobile-terminal-create-route-owner'
import { launchMobileSessionQuickCommand } from './mobile-session-quick-command-launch'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import { requestMobileSessionTerminalCreate } from './mobile-session-terminal-create-request'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { createMobileStructuredAgentSession } from './mobile-structured-agent-session-launch'
import { launchesThroughHost, launchNewTabAgentThroughHost } from './new-tab-agent-host-launch'
import {
  launchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch,
  withoutPendingHandle
} from './pending-session-selection'
import { releaseTerminalCreateLock } from './terminal-create-lock'
import { placeCreatedSessionTab } from '../../../src/shared/session-tab-placement'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'

export function useMobileSessionTerminalCreateActions(scope: MobileSessionAttachmentsModel) {
  const {
    worktreeId,
    client,
    hostCapabilities,
    setTerminals,
    terminalsRef,
    setSessionTabs,
    defaultTerminalHandlesToLiveInput,
    setActiveHandle,
    activeSessionTabId,
    setActiveSessionTabId,
    setCreating,
    creatingTerminalRef,
    setCreateError,
    deviceTokenRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingSelectionRef,
    scheduleDelayedAction,
    showToast,
    unsubscribeTerminal,
    subscribeToTerminal,
    fetchSessionTabs
  } = scope
  const captureCreateOwner = useMobileTerminalCreateRouteOwner(scope)

  type CreateOutcome = 'created' | 'accepted' | 'busy' | 'unavailable' | 'reported-failure'
  async function handleCreateTerminal(
    agent?: MobileNewTabAgentOption['agent'],
    options?: MobileQuickCommandLaunch['options'] & {
      onPromptSent?: () => void
      errorToast?: string
      sourceChatFork?: { sessionId: string; agent: string }
    }
  ): Promise<CreateOutcome | undefined> {
    const sourceFork = options?.sourceChatFork
    const sourceOutcome = (value: CreateOutcome): CreateOutcome | undefined =>
      sourceFork ? value : undefined
    const agentName = sourceFork ? formatAgentTypeLabel(sourceFork.agent) : ''
    const { isRouteCurrent, isCurrent } = captureCreateOwner(sourceFork?.sessionId)
    const reportFork = (message: string): void => {
      if (!sourceFork || !isCurrent()) {
        return
      }
      setCreateError(message)
      triggerError()
      showToast(message, 3000)
    }
    if (
      !client ||
      (sourceFork && (!hostSupportsMobileChatFork(hostCapabilities) || !isCurrent()))
    ) {
      reportFork(`Open the ${agentName} chat on a connected, updated host and try again.`)
      return sourceOutcome('unavailable')
    }
    if (creatingTerminalRef.current) {
      reportFork(`Another terminal is opening. Wait, then retry the ${agentName} chat.`)
      return sourceOutcome('busy')
    }
    // Why: idempotency key so a transport retry (reconnect replay) resolves to the same terminal, not a duplicate; kept compact (no worktree id) for the schema length cap.
    const clientMutationId = `mobile-create:${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`
    // Also names the "+" lock, which a launch frees when its tab lands.
    creatingTerminalRef.current = clientMutationId

    setCreating(true)
    setCreateError('')

    // Why: the host names the real cause (pty exhaustion, disabled agent, unresolved worktree);
    // collapsing every failure to 'Failed to create terminal' left the phone undiagnosable.
    function reportCreateFailure(hostReason: string): void {
      if (!isCurrent()) {
        return
      }
      const reason = hostReason.trim() || options?.errorToast || 'Failed to create terminal'
      setCreateError(reason)
      // Why: the inline error renders only in an empty session; beside open tabs only a toast is seen.
      triggerError()
      showToast(options?.errorToast ?? reason, 1800)
    }

    try {
      if (
        agent &&
        launchesThroughHost(options) &&
        (await launchNewTabAgentThroughHost({
          client,
          hostCapabilities,
          worktreeId,
          agent,
          options,
          lock: clientMutationId,
          activeSessionTabId,
          pendingSelectionRef,
          fetchSessionTabs,
          getSessionTabs: () => scope.sessionTabsRef.current,
          showToast,
          reportCreateFailure,
          setCreateError
        }))
      ) {
        return sourceOutcome('accepted')
      }
      // COMPAT(agent.launch.v2): hosts before v1.4.206 keep the paths below; remove once none remain.
      // Bare structured-provider launches follow host createSupport; prompted launches keep their startup semantics.
      if (isAgentSessionHandleProvider(agent) && options === undefined) {
        // Armed before asking with nothing to match yet, so a tab picked meanwhile still wins.
        pendingSelectionRef.current = launchedSelection(clientMutationId, {}, null)
        const structured = await createMobileStructuredAgentSession(client, worktreeId, agent)
        if (structured.kind === 'created') {
          // Found by session in the next snapshot, never by a predicted tab id; the current tab stays
          // live until then, as on the launch path above.
          const reply = { sessionId: structured.sessionId }
          pendingSelectionRef.current = withLaunchReply(
            pendingSelectionRef.current,
            clientMutationId,
            reply
          )
          void fetchSessionTabs()
          return sourceOutcome('accepted')
        }
        if (structured.kind === 'unknown') {
          // Never create a legacy sibling when the host may already have committed.
          setCreateError(structured.message)
          triggerError()
          showToast(structured.message, 1800)
          return sourceOutcome('reported-failure')
        }
      }
      const afterTabId = activeSessionTabId ?? undefined
      const hostSupportsGroupedPlacement =
        hostCapabilities?.includes(SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY) === true
      const response = await requestMobileSessionTerminalCreate({
        client,
        worktreeId,
        afterTabId,
        clientMutationId,
        agent,
        options,
        ...(sourceFork ? { sourceChatFork: { sessionId: sourceFork.sessionId } } : {})
      })
      if (!isCurrent()) {
        return sourceOutcome('accepted')
      }
      const forkMessage = sourceFork ? mobileChatForkCreateReplyMessage(agentName, response) : null
      if (forkMessage && !response.ok) {
        reportFork(forkMessage)
        return sourceOutcome('reported-failure')
      }
      // A refused ordinary create throws the host's message into the existing catch.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
      const created = sessionTabCreateTerminal.interpret(response) as Extract<
        MobileSessionTab,
        { type: 'terminal' }
      >
      if (forkMessage) {
        reportFork(forkMessage)
      }
      // Why: unsubscribe the old terminal so the server restores its desktop dims; otherwise its restore timer is never set.
      const prev = activeHandleRef.current
      if (prev) {
        unsubscribeTerminal(prev)
      }
      if (sourceFork) {
        scope.nativeChatController.setTabView(created.id, 'terminal')
      }
      pendingSelectionRef.current = { kind: 'tab', tabId: created.id }
      activeSessionTabTypeRef.current = 'terminal'
      setActiveSessionTabId(created.id)
      // Forks and older hosts need the host snapshot's order, including its pin partition.
      if (hostSupportsGroupedPlacement && !sourceFork) {
        setSessionTabs((prev) => {
          if (!isCurrent()) {
            return prev
          }
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
          if (!isCurrent()) {
            return prev
          }
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
      scheduleDelayedAction(() => {
        if (isCurrent()) {
          void fetchSessionTabs()
        }
      }, 500)
      return sourceOutcome('created')
    } catch (error) {
      if (sourceFork) {
        reportFork(mobileChatForkRequestFailureMessage(agentName, error))
        return sourceOutcome('reported-failure')
      }
      reportCreateFailure(error instanceof Error ? error.message : '')
      return sourceOutcome('reported-failure')
    } finally {
      if (isRouteCurrent()) {
        pendingSelectionRef.current = withoutUnansweredLaunch(
          pendingSelectionRef.current,
          clientMutationId
        )
        releaseTerminalCreateLock({ creatingTerminalRef, setCreating }, clientMutationId)
      }
    }
  }

  return {
    handleCreateTerminal,
    launchQuickCommand: (command: TerminalQuickCommand) =>
      launchMobileSessionQuickCommand(scope, handleCreateTerminal, command)
  }
}

export type MobileSessionTerminalCreateActionsModel = MobileSessionAttachmentsModel &
  ReturnType<typeof useMobileSessionTerminalCreateActions>
