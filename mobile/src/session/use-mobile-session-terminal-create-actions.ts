import {
  buildMobileQuickCommandLaunch,
  type MobileQuickCommandLaunch
} from '../terminal/quick-commands'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { triggerSuccess, triggerError } from '../platform/haptics'
import { buildTerminalSendParams } from '../terminal/terminal-send-request'
import { terminalRecordsEqual } from './mobile-terminal-records'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import type { Terminal, TerminalCreateResult } from './mobile-session-route-types'
import type { MobileSessionAttachmentsModel } from './use-mobile-session-attachments'
import { createMobileStructuredCodexSession } from './mobile-structured-agent-session-launch'

export function useMobileSessionTerminalCreateActions(scope: MobileSessionAttachmentsModel) {
  const {
    worktreeId,
    client,
    connState,
    setTerminals,
    terminalsRef,
    setSessionTabs,
    defaultTerminalHandlesToLiveInput,
    setActiveHandle,
    activeSessionTabId,
    activeSessionTabIdRef,
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
    pendingActiveSessionTabIdRef,
    pendingActiveTerminalHandleRef,
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

    try {
      // Bare Codex launches follow structured support; prompted launches keep their startup semantics.
      if (agent === 'codex' && options === undefined) {
        const structured = await createMobileStructuredCodexSession(client, worktreeId)
        if (structured.kind === 'created') {
          const previous = activeHandleRef.current
          if (previous) {
            unsubscribeTerminal(previous)
            initializedHandlesRef.current.delete(previous)
          }
          const tabId = `agent-session:${structured.sessionId}`
          pendingActiveSessionTabIdRef.current = tabId
          pendingActiveTerminalHandleRef.current = null
          activeSessionTabTypeRef.current = 'agent-session'
          activeSessionTabIdRef.current = tabId
          setActiveSessionTabId(tabId)
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
      const response = await client.sendRequest('session.tabs.createTerminal', {
        worktree: `id:${worktreeId}`,
        afterTabId: activeSessionTabId ?? undefined,
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
      if (response.ok) {
        const result = (response as RpcSuccess).result as TerminalCreateResult
        const created = result.tab
        // Why: unsubscribe the old terminal so the server restores its desktop dims; otherwise its restore timer is never set.
        const prev = activeHandleRef.current
        if (prev) {
          unsubscribeTerminal(prev)
          initializedHandlesRef.current.delete(prev)
        }
        pendingActiveSessionTabIdRef.current = created.id
        activeSessionTabTypeRef.current = 'terminal'
        setActiveSessionTabId(created.id)
        setSessionTabs((prev) => {
          if (prev.some((tab) => tab.id === created.id)) {
            return prev
          }
          return [...prev, { ...created, isActive: true }]
        })
        if (typeof created.terminal === 'string') {
          const createdHandle = created.terminal
          defaultTerminalHandlesToLiveInput([createdHandle])
          // Why: snapshots lag the create RPC; without this marker applySessionTabs reverts the active handle, blanking the new pane.
          pendingActiveTerminalHandleRef.current = createdHandle
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
                  options.errorToast ??
                    (err instanceof Error ? err.message : "Couldn't send notes"),
                  1800
                )
              })
          } else if (options?.successToast) {
            triggerSuccess()
            showToast(options.successToast)
          }
        } else {
          // Why: a prior pending handle must not outlive a create that returned no terminal; web-ready subscribe gates on this ref.
          pendingActiveTerminalHandleRef.current = null
          activeHandleRef.current = null
          setActiveHandle(null)
        }
        scheduleDelayedAction(() => void fetchSessionTabs(), 500)
      } else {
        const message = options?.errorToast ?? 'Failed to create terminal'
        setCreateError(message)
        if (options?.errorToast) {
          triggerError()
          showToast(message, 1800)
        }
      }
    } catch {
      const message = options?.errorToast ?? 'Failed to create terminal'
      setCreateError(message)
      if (options?.errorToast) {
        triggerError()
        showToast(message, 1800)
      }
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
