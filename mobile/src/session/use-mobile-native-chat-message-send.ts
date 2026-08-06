import { useCallback, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  clearMobileNativeChatInput,
  openMobileNativeChatSendBudget,
  sendMobileNativeChatMessageWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { healMobileNativeChatStaleInput } from './mobile-native-chat-stale-input'
import { classifyMobileNativeChatSend } from './mobile-native-chat-send-classification'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from './mobile-native-chat-terminal-write-lock'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'
import { t } from '@/i18n/mobile-i18n'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import { buildAgentTuiClearInputForText } from '../../../src/shared/agent-tui-input-clear'

export type MobileNativeChatMessageSend = {
  /** Composer send that syncs the draft (clear on send, restore on rejection). */
  send: (text: string, images?: string[]) => Promise<boolean>
  /** Outcome-preserving variant: callers that pasted terminal input beforehand
   *  (image sends) must see 'unknown' to heal a possibly-orphaned paste. Such a
   *  caller passes its own `deadline` so the paste it already spent and this text
   *  body share one budget instead of holding the composer for two. */
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number
  ) => Promise<MobileNativeChatSendOutcome>
  /** Answer to an agent question — never touches the composer draft. */
  answerQuestion: (text: string) => Promise<boolean>
  /** Session-option command dispatch (e.g. `/model sonnet`) — never touches the
   *  composer draft; callers need the outcome to track dispatched state. */
  dispatchCommand: (text: string) => Promise<MobileNativeChatSendOutcome>
}

/** The native-chat send seam: one write path shared by composer sends, image
 *  sends, and question answers, wired to the drafts accounting. */
export function useMobileNativeChatMessageSend(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  /** Active tab's agent — classification is per-agent (command catalogs differ). */
  agentRef: MutableRefObject<string | null>
  /** Captured when a control send starts so a later tab switch cannot record its
   *  session-option effects against the newly active tab. */
  commandSendRef: MutableRefObject<(command: string) => void>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  /** Launch-context text Orca parked on the agent's TUI input line, or null. Read
   *  at send time so the pre-clear can be sized to every line it occupies. */
  readSeededLaunchDraftSeed: () => MobileNativeChatLaunchDraftSeed | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
  onSendError: (message: string) => void
}): MobileNativeChatMessageSend {
  const {
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    agentRef,
    commandSendRef,
    captureSendOrigin,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend,
    onSendError
  } = args

  const sendMessage = useCallback(
    async (
      text: string,
      images: string[] | undefined,
      syncComposer: boolean,
      recordControlSend: boolean,
      sharedDeadline?: number
    ): Promise<MobileNativeChatSendOutcome> => {
      const handle = handleRef.current
      const origin = captureSendOrigin(text)
      const agent = agentRef.current
      const recordCommand = commandSendRef.current
      // Why: the lease collapses one render after `connState`, so a question-card
      // answer (which reaches this send directly) would otherwise burn the whole
      // 15s heal+send budget waiting on a socket that is already gone.
      if (!client || !handle || !origin || !enabled) {
        onSendError(t('useMobileNativeChatMessageSend.messageNotSentDisconnected'))
        return 'rejected'
      }
      // The agent's input may still hold an orphaned image paste from an earlier
      // send (#10228); submitting on top of it would glue the image onto this
      // message. Healed before the draft clear so a failed heal — which sends
      // nothing — leaves the composer exactly as the user left it.
      // One budget for the whole action: a hung heal must eat into the text send's
      // time, not hand it a fresh timeout and pin the composer for twice as long.
      // An image send already opened one covering its paste — keep spending that.
      const deadline = sharedDeadline ?? openMobileNativeChatSendBudget()
      const healArgs = {
        client,
        terminal: handle,
        deviceToken: deviceTokenRef.current,
        deadline
      }
      if (!(await healMobileNativeChatStaleInput(healArgs))) {
        onSendError(t('useMobileNativeChatMessageSend.messageNotSent'))
        return 'rejected'
      }
      // Why: empty the composer at send time, not on the ack — over relay the
      // round trip is visible, and a lost ack must not strand the sent prompt
      // in the box. Only a definite rejection puts the text back.
      if (syncComposer) {
        clearDraftForSend(origin, text)
      }
      // Why: a parked launch draft is routinely multi-line, and one Ctrl+U clears
      // only one logical line. Size the clear to the text Orca injected, with
      // slack — the user can also have typed into the TUI line directly, so that
      // line count is a lower bound. Mobile cannot read the agent's screen, so
      // there is no empty-line observable to confirm against here; the upper
      // bound plus the host's write acceptance is what makes it safe.
      //
      // The burst goes out as its OWN write: bundled into the body write it
      // arrived as literal Ctrl+U text and the draft concatenated (see
      // clearMobileNativeChatInput). A rejected clear aborts the send rather
      // than pasting on top of an uncleared line.
      const seededLaunchDraft = readSeededLaunchDraftSeed()
      if (seededLaunchDraft && !images?.length) {
        const cleared = await clearMobileNativeChatInput({
          client,
          terminal: handle,
          clearInput: buildAgentTuiClearInputForText(seededLaunchDraft.text),
          deadline,
          ...(deviceTokenRef.current
            ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
            : {})
        })
        if (!cleared) {
          if (syncComposer) {
            restoreRejectedDraft(origin, text)
          }
          onSendError(t('useMobileNativeChatMessageSend.messageNotSent'))
          return 'rejected'
        }
      }
      const outcome = await sendMobileNativeChatMessageWithOutcome({
        client,
        terminal: handle,
        text,
        // Why: pre-clear only when nothing was deliberately pasted first. The heal
        // above fires only for terminals a mobile image paste marked, so a desktop
        // launch-draft prefill parked on the input line would otherwise glue onto
        // this message. An image send already led its own paste with Ctrl+U, and a
        // second one here would wipe the image it just pasted (desktop's image path
        // likewise clears once, before the paste, and never again).
        //
        // Also skipped once the dedicated clear above ran: the line is already
        // empty, and a Ctrl+U written immediately before body text in the SAME
        // write reaches the agent as a literal control character rather than a
        // keypress (observed live as a stray \x15 heading the received message).
        clearInputFirst: !images?.length && !seededLaunchDraft,
        ...(syncComposer && typeof seededLaunchDraft?.createdAt === 'number'
          ? {
              resolvedLaunchDraft: {
                text: seededLaunchDraft.text,
                createdAt: seededLaunchDraft.createdAt
              }
            }
          : {}),
        deadline,
        ...(deviceTokenRef.current
          ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
          : {})
      })
      // Why (desktop parity): a slash/skill send dispatches into the agent's own
      // TUI, not the conversation — the transcript never echoes it as a user
      // turn, so an optimistic bubble would sit at "Queued" forever and the
      // unconfirmed hold could never observe a landing.
      const classification = classifyMobileNativeChatSend(agent, text)
      if (outcome === 'unknown') {
        if (classification === 'chat') {
          // Why: an ack-lost send usually WAS delivered (issue seen on cellular
          // relay) — verify via the transcript echo instead of a false "not sent".
          holdUnconfirmedSend(origin, text, () =>
            onSendError(t('useMobileNativeChatMessageSend.delivery'))
          )
        }
        return 'unknown'
      }
      if (outcome === 'rejected') {
        if (syncComposer) {
          restoreRejectedDraft(origin, text)
        }
        onSendError(t('useMobileNativeChatMessageSend.messageNotSent'))
        return 'rejected'
      }
      if (classification === 'chat') {
        // `images` are local preview URIs for the optimistic echo only — the actual
        // image bytes already rode along as a bracketed paste before this text send.
        acceptSend(origin, text, images)
      } else if (recordControlSend) {
        // The session-option catalog can recognize controls omitted from the
        // autocomplete catalog (for example Claude `/model` and `/fast`).
        recordCommand(text.trim())
      }
      return 'accepted'
    },
    [
      acceptSend,
      agentRef,
      captureSendOrigin,
      clearDraftForSend,
      client,
      commandSendRef,
      deviceTokenRef,
      enabled,
      handleRef,
      holdUnconfirmedSend,
      onSendError,
      readSeededLaunchDraftSeed,
      restoreRejectedDraft
    ]
  )

  const sendWithOutcome = useCallback(
    (text: string, images?: string[], deadline?: number) =>
      sendMessage(text, images, true, true, deadline),
    [sendMessage]
  )

  // Boolean surface for callers with no pre-pasted input: 'unknown' stays true
  // (the send usually landed; the optimistic echo is already held unconfirmed).
  const send = useCallback(
    async (text: string, images?: string[]): Promise<boolean> =>
      (await sendWithOutcome(text, images)) !== 'rejected',
    [sendWithOutcome]
  )

  // A question answer is not composer text, so it never syncs the draft. It
  // reaches this send directly (not through the image hook's locked path), so
  // it takes the per-terminal write lock itself: an answer landing mid-flight
  // in an image paste sequence would interleave bytes into the PTY.
  const answerQuestion = useCallback(
    async (text: string): Promise<boolean> => {
      const terminal = handleRef.current
      if (terminal && !acquireMobileNativeChatTerminalWrite(terminal)) {
        onSendError(t('useMobileNativeChatAnswerSend.answerNotSent'))
        return false
      }
      try {
        return (await sendMessage(text, undefined, false, true)) !== 'rejected'
      } finally {
        if (terminal) {
          releaseMobileNativeChatTerminalWrite(terminal)
        }
      }
    },
    [handleRef, onSendError, sendMessage]
  )

  // A session-option apply writes to the same input line as a send, and the host
  // spaces a send's body and its Enter ~500ms apart — so without this lock an
  // apply lands between them and is submitted as part of the user's prompt.
  const dispatchCommand = useCallback(
    async (text: string): Promise<MobileNativeChatSendOutcome> => {
      const terminal = handleRef.current
      if (terminal && !acquireMobileNativeChatTerminalWrite(terminal)) {
        return 'rejected'
      }
      try {
        return await sendMessage(text, undefined, false, false)
      } finally {
        if (terminal) {
          releaseMobileNativeChatTerminalWrite(terminal)
        }
      }
    },
    [handleRef, sendMessage]
  )

  return { send, sendWithOutcome, answerQuestion, dispatchCommand }
}
