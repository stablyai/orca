import { useCallback } from 'react'
import { Keyboard } from 'react-native'
import { triggerError } from '../platform/haptics'
import type { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { sendTerminalLiveAccessoryRawBytes } from '../terminal/terminal-live-accessory-raw-send'
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
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

export function useMobileSessionTerminalSendActions(scope: MobileSessionTerminalWebviewModel) {
  const {
    client,
    activeHandle,
    activeSessionTab,
    setActionTarget,
    setMarkdownActionTarget,
    setFileActionTarget,
    setBrowserActionTarget,
    keyboardHeight,
    deviceTokenRef,
    clientRef,
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
    showToast
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
    // Why: the return key still submits while offline; hold the composed text instead of firing a doomed RPC (#6713).
    if (!client || !activeHandle || sendingRef.current || !canSend) {
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
      // Why: fail now and restore the text — a send parked across a reconnect would execute long after the tap.
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
      const accepted = isTerminalSendRpcAccepted(response)
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

  async function handleAccessoryKey(input: ReturnType<typeof createTerminalLiveAccessoryInput>) {
    if (!client || !activeHandle || !canSend) {
      return
    }
    const targetHandle = activeHandle
    const accessoryCommit = await handleLiveInputAccessoryBytes(input)
    if (accessoryCommit.kind !== 'allow-raw') {
      return
    }
    await sendTerminalLiveAccessoryRawBytes({
      client: clientRef.current,
      targetHandle,
      activeHandle: activeHandleRef.current,
      activeSessionTabType: activeSessionTabTypeRef.current,
      connState: connStateRef.current,
      bytes: input.bytes,
      deviceToken: deviceTokenRef.current
    })
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
      const rpc = clientRef.current
      // Why: callers suppress follow-up controls/toasts when this live send is stale.
      if (
        !rpc ||
        connStateRef.current !== 'connected' ||
        handle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return false
      }
      // Why: live-mirror deltas queued behind a dying send drain into the connect
      // wait and replay stale bytes after reconnect (#6713's `YZZYecho …` corruption).
      return rpc
        .sendRequest(
          'terminal.send',
          buildTerminalSendParams({
            terminal: handle,
            text,
            enter: false,
            deviceToken: deviceTokenRef.current
          }),
          TERMINAL_INPUT_SEND_OPTIONS
        )
        .then(isTerminalSendRpcAccepted, () => false)
    },
    [showToast]
  )
  sendLiveTerminalInputRef.current = sendLiveTerminalInput

  const clearSessionTabActionSheetKeyboardListener = useCallback(() => {
    sessionTabActionSheetKeyboardHideSubRef.current?.remove()
    sessionTabActionSheetKeyboardHideSubRef.current = null
  }, [])

  const openSessionTabActionSheet = useCallback((tab: MobileSessionTab) => {
    if (tab.type === 'terminal') {
      if (typeof tab.terminal !== 'string') {
        return
      }
      setActionTarget({
        handle: tab.terminal,
        title: tab.title,
        isActive: tab.terminal === activeHandleRef.current
      })
    } else if (tab.type === 'markdown') {
      setMarkdownActionTarget(tab)
    } else if (tab.type === 'file') {
      setFileActionTarget(tab)
    } else {
      setBrowserActionTarget(tab)
    }
  }, [])

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
