import { reportWorkerTerminalUserInput } from '../terminal/worker-terminal-takeover-report'
import { useCallback } from 'react'
import { Keyboard } from 'react-native'
import { translate } from '../i18n/mobile-i18n'
import { triggerError } from '../platform/haptics'
import type { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { sendTerminalLiveAccessoryRawBytes } from '../terminal/terminal-live-accessory-raw-send'
import {
  clearTerminalLiveInputFocusTimer,
  isTerminalLiveInputWithinByteLimit
} from '../terminal/terminal-live-input'
import { dismissTerminalKeyboard } from '../terminal/terminal-keyboard-dismiss'
import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../terminal/terminal-send-request'
import { normalizeTerminalTextInput } from '../terminal/terminal-text-input-normalization'
import { encodeTerminalKeyForModes } from '../terminal/terminal-key-mode-encoding'
import { useTerminalTextFieldSubmitBinding } from '../terminal/use-terminal-text-field-submit-binding'
import { useAgentSendKeyboardDismissal } from './use-agent-send-keyboard-dismissal'
import type { MobileSessionTab } from './mobile-session-route-types'
import { useMobileSessionTabActionSheetOpener } from './use-mobile-session-tab-action-targets'
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
    setAgentSessionActionTarget,
    keyboardHeight,
    deviceTokenRef,
    clientRef,
    connStateRef,
    liveInputRef,
    commandInputRef,
    ptyModesRef,
    liveInputFocusTimerRef,
    sendLiveTerminalInputRef,
    sessionTabActionSheetKeyboardHideSubRef,
    sessionTabActionSheetRequestSeqRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    sendingRef,
    bufferedTerminalDraftState,
    getSendCompletionGeneration,
    getLiveInteractionGeneration,
    handleLiveInputAccessoryBytes,
    handleLiveInputSubmit,
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

  const submitLiveInput = useCallback(() => {
    const submit = handleLiveInputSubmit()
    const sendOrigin = {
      tab: activeSessionTab,
      generation: getSendCompletionGeneration(),
      interaction: getLiveInteractionGeneration()
    }
    void submit.then((accepted) =>
      dismissKeyboardAfterAgentSend(
        sendOrigin,
        accepted && sendOrigin.interaction === getLiveInteractionGeneration()
      )
    )
  }, [activeSessionTab, dismissKeyboardAfterAgentSend, handleLiveInputSubmit])
  const bindLiveInputField = useTerminalTextFieldSubmitBinding(
    liveInputRef,
    submitLiveInput,
    (input) => {
      if (!client || !activeHandle || !canSend) {
        return false
      }
      void handleAccessoryKey(input)
      return true
    }
  )
  const submitBufferedDraft = (): void => {
    void handleSend()
  }
  const bindCommandField = useTerminalTextFieldSubmitBinding(commandInputRef, submitBufferedDraft)

  async function handleSend() {
    // Offline Return must preserve composed text instead of firing a doomed write.
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
      // Fail/restore immediately so reconnect cannot execute stale text long after the tap.
      const response = await terminalInputSend.request(
        client,
        buildTerminalSendParams({
          terminal: activeHandle,
          text,
          enter: true,
          deviceToken: deviceTokenRef.current
        }),
        TERMINAL_INPUT_SEND_OPTIONS
      )
      const accepted = terminalInputSend.interpret(response) === true
      if (accepted) {
        reportWorkerTerminalUserInput(client, activeHandle)
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
    targetHandle = activeHandle,
    isDeliveryTargetCurrent: () => boolean = () => true
  ): Promise<boolean> {
    if (
      !client ||
      !targetHandle ||
      targetHandle !== activeHandle ||
      !canSend ||
      !isDeliveryTargetCurrent()
    ) {
      return false
    }
    // Encode first so the live-input commit sees the bytes the PTY will receive.
    const encoded = {
      ...input,
      bytes: encodeTerminalKeyForModes(input.bytes, ptyModesRef.current.get(targetHandle))
    }
    const accessoryCommit = await handleLiveInputAccessoryBytes(encoded)
    if (!isDeliveryTargetCurrent() || clientRef.current !== client) {
      return false
    }
    if (accessoryCommit.kind !== 'allow-raw') {
      return accessoryCommit.kind === 'handled'
    }
    return sendTerminalLiveAccessoryRawBytes({
      client,
      targetHandle,
      activeHandle: activeHandleRef.current,
      activeSessionTabType: activeSessionTabTypeRef.current,
      connState: connStateRef.current,
      bytes: encoded.bytes,
      deviceToken: deviceTokenRef.current
    })
  }

  const sendLiveTerminalInput = useCallback(
    async (handle: string, bytes: string): Promise<boolean> => {
      const text = encodeTerminalKeyForModes(
        normalizeTerminalTextInput(bytes),
        ptyModesRef.current.get(handle)
      )
      if (text.length === 0) {
        return false
      }
      if (!isTerminalLiveInputWithinByteLimit(text)) {
        triggerError()
        showToast(
          translate(
            'session.useSessionTerminalSendActions.inputTooLarge',
            'Input too large (max 256 KiB)'
          ),
          1500
        )
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
      // Discard live-mirror deltas behind a dying send so reconnect cannot replay stale bytes.
      return terminalInputSend
        .request(
          rpc,
          buildTerminalSendParams({
            terminal: handle,
            text,
            enter: false,
            deviceToken: deviceTokenRef.current
          }),
          TERMINAL_INPUT_SEND_OPTIONS
        )
        .then(
          (response) => {
            const accepted = terminalInputSend.interpret(response) === true
            if (accepted) {
              reportWorkerTerminalUserInput(rpc, handle)
            }
            return accepted
          },
          () => false
        )
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
      // Wait for keyboard dismissal before opening the sheet or queued refocus can race under it.
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
    dismissKeyboardAfterAgentSend,
    bindLiveInputField,
    bindCommandField,
    submitLiveInput
  }
}

export type MobileSessionTerminalSendActionsModel = MobileSessionTerminalWebviewModel &
  ReturnType<typeof useMobileSessionTerminalSendActions>
