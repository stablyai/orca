import type { MobileQuickCommandLaunch } from '../terminal/quick-commands'
import type { RpcSuccess } from '../transport/types'
import { sessionTabCreateTerminal } from './mobile-session-write-operations'
import { triggerSuccess, triggerError } from '../platform/haptics'
import { terminalCreateCopy } from './mobile-session-terminal-create-copy'
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
      reportFork(terminalCreateCopy.forkUnavailable(agentName))
      return sourceOutcome('unavailable')
    }
    if (creatingTerminalRef.current) {
      reportFork(terminalCreateCopy.forkBusy(agentName))
      return sourceOutcome('busy')
    }
    // Use a compact idempotency key so reconnect retries resolve the same terminal within schema length limits.
    const clientMutationId = `mobile-create:${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`
    creatingTerminalRef.current = clientMutationId

    setCreating(true)
    setCreateError('')

    // Surface host-specific create errors so users can distinguish exhausted PTYs, disabled agents and missing ownership.
    function reportCreateFailure(hostReason: string): void {
      if (!isCurrent()) {
        return
      }
      const reason = hostReason.trim() || options?.errorToast || terminalCreateCopy.createFailed()
      setCreateError(reason)
      // Only empty sessions show inline errors; existing tabs need toast feedback.
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
        // Arm before requesting so later user tab picks supersede the launch.
        pendingSelectionRef.current = launchedSelection(clientMutationId, {}, null)
        const structured = await createMobileStructuredAgentSession(client, worktreeId, agent)
        if (structured.kind === 'created') {
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
      // Unsubscribe the old terminal to arm restoration of its desktop dimensions.
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
        // Protect the new active handle until host snapshots catch up or the pane can blank.
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
            title: created.title || existing?.title || terminalCreateCopy.terminalTitle(),
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
                throw new Error(sendResponse.error.message || terminalCreateCopy.sendNotesFailed())
              }
              const result = (sendResponse as RpcSuccess).result as {
                send?: { accepted?: boolean }
              }
              if (result.send?.accepted === false) {
                throw new Error(terminalCreateCopy.inputLocked())
              }
              triggerSuccess()
              showToast(options.successToast ?? terminalCreateCopy.notesSent())
              options.onPromptSent?.()
            })
            .catch((err) => {
              triggerError()
              showToast(
                options.errorToast ??
                  (err instanceof Error ? err.message : terminalCreateCopy.sendNotesError()),
                1800
              )
            })
        } else if (options?.successToast) {
          triggerSuccess()
          showToast(options.successToast)
        }
      } else {
        // Clear old pending handles when create returns none so WebView-ready cannot subscribe stale state.
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
