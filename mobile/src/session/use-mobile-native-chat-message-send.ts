import { useCallback, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  openMobileNativeChatSendBudget,
  sendMobileNativeChatMessageWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { healMobileNativeChatStaleInput } from './mobile-native-chat-stale-input'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'

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
}

/** The native-chat send seam: one write path shared by composer sends, image
 *  sends, and question answers, wired to the drafts accounting. */
export function useMobileNativeChatMessageSend(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
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
    captureSendOrigin,
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
      sharedDeadline?: number
    ): Promise<MobileNativeChatSendOutcome> => {
      const handle = handleRef.current
      const origin = captureSendOrigin(text)
      // Why: the lease collapses one render after `connState`, so a question-card
      // answer (which reaches this send directly) would otherwise burn the whole
      // 15s heal+send budget waiting on a socket that is already gone.
      if (!client || !handle || !origin || !enabled) {
        onSendError('Message not sent (disconnected)')
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
        onSendError('Message not sent')
        return 'rejected'
      }
      // Why: empty the composer at send time, not on the ack — over relay the
      // round trip is visible, and a lost ack must not strand the sent prompt
      // in the box. Only a definite rejection puts the text back.
      if (syncComposer) {
        clearDraftForSend(origin, text)
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
        clearInputFirst: !images?.length,
        deadline,
        ...(deviceTokenRef.current
          ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
          : {})
      })
      if (outcome === 'unknown') {
        // Why: an ack-lost send usually WAS delivered (issue seen on cellular
        // relay) — verify via the transcript echo instead of a false "not sent".
        holdUnconfirmedSend(origin, text, () =>
          onSendError('Delivery unconfirmed — check chat before retrying')
        )
        return 'unknown'
      }
      if (outcome === 'rejected') {
        if (syncComposer) {
          restoreRejectedDraft(origin, text)
        }
        onSendError('Message not sent')
        return 'rejected'
      }
      // `images` are local preview URIs for the optimistic echo only — the actual
      // image bytes already rode along as a bracketed paste before this text send.
      acceptSend(origin, text, images)
      return 'accepted'
    },
    [
      acceptSend,
      captureSendOrigin,
      clearDraftForSend,
      client,
      deviceTokenRef,
      enabled,
      handleRef,
      holdUnconfirmedSend,
      onSendError,
      restoreRejectedDraft
    ]
  )

  const sendWithOutcome = useCallback(
    (text: string, images?: string[], deadline?: number) =>
      sendMessage(text, images, true, deadline),
    [sendMessage]
  )

  // Boolean surface for callers with no pre-pasted input: 'unknown' stays true
  // (the send usually landed; the optimistic echo is already held unconfirmed).
  const send = useCallback(
    async (text: string, images?: string[]): Promise<boolean> =>
      (await sendWithOutcome(text, images)) !== 'rejected',
    [sendWithOutcome]
  )

  // A question answer is not composer text, so it never syncs the draft.
  const answerQuestion = useCallback(
    async (text: string): Promise<boolean> =>
      (await sendMessage(text, undefined, false)) !== 'rejected',
    [sendMessage]
  )

  return { send, sendWithOutcome, answerQuestion }
}
