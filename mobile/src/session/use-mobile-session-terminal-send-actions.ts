import { useCallback } from 'react'
import { Keyboard } from 'react-native'
import type { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { getTerminalLiveAccessoryRawSendTarget } from '../terminal/terminal-live-accessory-raw-send-target'
import {
  clearTerminalLiveInputFocusTimer,
  isTerminalLiveInputWithinByteLimit
} from '../terminal/terminal-live-input'
import { dismissTerminalKeyboard } from '../terminal/terminal-keyboard-dismiss'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../terminal/terminal-send-request'
import { normalizeTerminalTextInput } from '../terminal/terminal-text-input-normalization'
import { useAgentSendKeyboardDismissal } from './use-agent-send-keyboard-dismissal'
import type { MobileSessionTab } from './mobile-session-route-types'
import { useMobileSessionTabActionSheetOpener } from './use-mobile-session-tab-action-targets'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'
import type { RpcClient } from '../transport/rpc-client'

export function useMobileSessionTerminalSendActions(scope: MobileSessionTerminalWebviewModel) {
  const {
    client,
    activeHandle,
    activeSessionTab,
    setActionTarget,
    setMarkdownActionTarget,
    setFileActionTarget,
    setBrowserActionTarget,
    setAgentSessionActionTarget,
    keyboardHeight,
    deviceTokenRef,
    connStateRef,
    liveInputRef,
    commandInputRef,
    liveInputFocusTimerRef,
    sendLiveTerminalInputRef,
    sessionTabActionSheetKeyboardHideSubRef,
    sessionTabActionSheetRequestSeqRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    sendingRef,
    bufferedTerminalDraftState,
    getSendCompletionGeneration,
    handleLiveInputAccessoryBytes,
    canSend,
    scheduleDelayedAction,
    showToast,
    sessionTerminalOperations,
    sessionTerminalOperationsProp,
    sessionTerminalOperationsRef,
    triggerError
  } = scope
  const TERMINAL_KEYBOARD_DISMISS_ACTION_SHEET_FALLBACK_MS = 450

  const dismissSoftwareKeyboard = useCallback(() => {
    dismissTerminalKeyboard({
      clearPendingLiveInputFocus: () => clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef),
      commandInput: commandInputRef.current,
      dismissKeyboard: () => Keyboard.dismiss(),
      liveInput: liveInputRef.current
    })
  }, [])
  const dismissKeyboardAfterAgentSend = useAgentSendKeyboardDismissal(
    dismissSoftwareKeyboard,
    getSendCompletionGeneration
  )

  async function handleSend() {
    if (!sessionTerminalOperations || !activeHandle || !canSend || sendingRef.current) {
      return
    }
    sendingRef.current = true

    const draft = bufferedTerminalDraftState.input
    const text = normalizeTerminalTextInput(draft)
    const bufferedDraftSend = bufferedTerminalDraftState.beginBufferedTerminalDraftSend(
      activeHandle,
      draft
    )
    const sendOrigin = {
      handle: activeHandle,
      tab: activeSessionTab,
      generation: getSendCompletionGeneration()
    }
    const restoreRejectedDraft = () =>
      bufferedTerminalDraftState.restoreRejectedDraft(bufferedDraftSend)

    try {
      let response: Awaited<ReturnType<RpcClient['sendRequest']>> | null = null
      if (client && !sessionTerminalOperationsProp) {
        const sendThroughClient = async () => {
          const response = await client.sendRequest(
            'terminal.send',
            buildTerminalSendParams({
              terminal: activeHandle,
              text,
              enter: true,
              deviceToken: deviceTokenRef.current
            }),
            TERMINAL_INPUT_SEND_OPTIONS
          )
          return response
        }
        response = await sendThroughClient()
      }
      let accepted = false
      if (response) {
        accepted = (() => {
          const accepted = isTerminalSendRpcAccepted(response)
          return accepted
        })()
      } else {
        accepted = await sessionTerminalOperations.sendInput(
          activeHandle,
          text,
          true,
          deviceTokenRef.current
        )
      }
      if (!accepted) {
        restoreRejectedDraft()
      }
      const draftUnchanged =
        accepted && bufferedTerminalDraftState.settleBufferedTerminalDraftSend(bufferedDraftSend)
      dismissKeyboardAfterAgentSend(sendOrigin, accepted && draftUnchanged)
    } catch {
      restoreRejectedDraft()
    } finally {
      bufferedTerminalDraftState.settleBufferedTerminalDraftSend(bufferedDraftSend)
      sendingRef.current = false
    }
  }

  async function handleAccessoryKey(
    input: ReturnType<typeof createTerminalLiveAccessoryInput>,
    targetHandle = activeHandleRef.current,
    isDeliveryTargetCurrent: () => boolean = () => targetHandle === activeHandleRef.current
  ): Promise<boolean> {
    if (
      !sessionTerminalOperationsRef.current ||
      !targetHandle ||
      !isDeliveryTargetCurrent() ||
      !canSend
    ) {
      return false
    }
    const accessoryCommit = await handleLiveInputAccessoryBytes(input)
    if (!isDeliveryTargetCurrent()) {
      return false
    }
    if (accessoryCommit.kind !== 'allow-raw') {
      return accessoryCommit.kind === 'handled'
    }
    const currentOperations = sessionTerminalOperationsRef.current
    // Why: async IME flushing can outlive the original terminal selection.
    const rawSendTarget = getTerminalLiveAccessoryRawSendTarget({
      targetHandle,
      activeHandle: activeHandleRef.current,
      activeSessionTabType: activeSessionTabTypeRef.current
    })
    if (!currentOperations || !rawSendTarget || connStateRef.current !== 'connected') {
      return false
    }
    return currentOperations.sendInput(rawSendTarget, input.bytes, false, deviceTokenRef.current)
  }

  const sendLiveTerminalInput = useCallback(
    async (handle: string, bytes: string): Promise<boolean> => {
      const text = normalizeTerminalTextInput(bytes)
      if (text.length === 0) {
        return false
      }
      if (!isTerminalLiveInputWithinByteLimit(text)) {
        triggerError()
        showToast('Input too large (max 256 KiB)', 1500)
        return false
      }
      const operations = sessionTerminalOperationsRef.current
      // Why: callers suppress follow-up controls/toasts when this live send is stale.
      if (
        !operations ||
        connStateRef.current !== 'connected' ||
        handle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return false
      }
      return operations.sendInput(handle, text, false, deviceTokenRef.current)
    },
    [showToast]
  )
  sendLiveTerminalInputRef.current = sendLiveTerminalInput

  const clearSessionTabActionSheetKeyboardListener = useCallback(() => {
    sessionTabActionSheetKeyboardHideSubRef.current?.remove()
    sessionTabActionSheetKeyboardHideSubRef.current = null
  }, [])

  const openSessionTabActionSheet = useMobileSessionTabActionSheetOpener({
    activeHandleRef,
    setActionTarget,
    setMarkdownActionTarget,
    setFileActionTarget,
    setBrowserActionTarget,
    setAgentSessionActionTarget
  })

  const openSessionTabActionSheetAfterKeyboardDismiss = useCallback(
    (tab: MobileSessionTab) => {
      // Why: live input may queue a refocus; open the action sheet after the keyboard is gone, not racing it under the drawer.
      sessionTabActionSheetRequestSeqRef.current += 1
      const requestSeq = sessionTabActionSheetRequestSeqRef.current
      clearSessionTabActionSheetKeyboardListener()
      let didOpen = false
      const openAfterDismiss = () => {
        if (didOpen || requestSeq !== sessionTabActionSheetRequestSeqRef.current) {
          return
        }
        didOpen = true
        clearSessionTabActionSheetKeyboardListener()
        openSessionTabActionSheet(tab)
      }

      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)

      if (keyboardHeight <= 0) {
        liveInputRef.current?.blur()
        Keyboard.dismiss()
        openAfterDismiss()
        return
      }

      sessionTabActionSheetKeyboardHideSubRef.current = Keyboard.addListener(
        'keyboardDidHide',
        openAfterDismiss
      )
      liveInputRef.current?.blur()
      Keyboard.dismiss()
      scheduleDelayedAction(openAfterDismiss, TERMINAL_KEYBOARD_DISMISS_ACTION_SHEET_FALLBACK_MS)
    },
    [
      clearSessionTabActionSheetKeyboardListener,
      keyboardHeight,
      openSessionTabActionSheet,
      scheduleDelayedAction
    ]
  )

  return {
    handleSend,
    handleAccessoryKey,
    sendLiveTerminalInput,
    clearSessionTabActionSheetKeyboardListener,
    openSessionTabActionSheet,
    openSessionTabActionSheetAfterKeyboardDismiss,
    dismissSoftwareKeyboard,
    dismissKeyboardAfterAgentSend
  }
}

export type MobileSessionTerminalSendActionsModel = MobileSessionTerminalWebviewModel &
  ReturnType<typeof useMobileSessionTerminalSendActions>
