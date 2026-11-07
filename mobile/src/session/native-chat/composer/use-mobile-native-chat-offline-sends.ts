import { useCallback, useEffect, useRef, useState } from 'react'
import { appendReturnedDraftText } from '../../../../../src/shared/returned-draft-text'
import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'
import type { MobileNativeChatInputLockReason } from '../MobileNativeChatView'
import {
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  returnMobileNativeChatDraftAttachments,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import {
  readMobileNativeChatPickedSkills,
  readMobileNativeChatSkillOrigin,
  restoreMobileNativeChatPickedSkills,
  setMobileNativeChatDraftText
} from './mobile-native-chat-draft-store'
import {
  queueMobileNativeChatOfflineSend,
  readMobileNativeChatOfflineSends,
  removeMobileNativeChatOfflineSends,
  resumeMobileNativeChatOfflineSends,
  returnMobileNativeChatOfflineSend,
  useMobileNativeChatOfflineSends,
  type MobileNativeChatOfflineSend
} from './mobile-native-chat-offline-sends'

type Send = (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>

export type MobileNativeChatOfflineQueue = {
  sends: readonly MobileNativeChatOfflineSend[]
  /** The composer's lock: a chat waiting on its terminal takes no input; an offline one queues. */
  composerLock: { disabled: boolean; offline: boolean }
  /** The composer's Send: queues while offline or behind earlier queued messages, else sends. */
  send: Send
  sendNow: (id: string) => Promise<boolean>
  remove: (ids: string[]) => Promise<boolean>
  resume: () => Promise<boolean>
  /** Takes a queued message back into the composer. */
  edit: (id: string) => Promise<boolean>
}

/** Sends typed while the desktop is out wait here, in order, and go once the chat can send again. */
export function useMobileNativeChatOfflineQueue(args: {
  scope: string | null
  /** The input lock as the chat reports it and as the composer shows it (settled). */
  lock: {
    raw: MobileNativeChatInputLockReason | null
    settled: MobileNativeChatInputLockReason | null
  }
  /** A terminal chat's prompt card owns Send, so a queued message would answer it. */
  promptOwnsSend: boolean
  send: Send
}): MobileNativeChatOfflineQueue {
  const { scope, lock, promptOwnsSend, send } = args
  const offline = lock.raw === 'disconnected'
  // Wait out the settle too, so a connection that blinks back doesn't send into a stale chat.
  const ready = lock.raw === null && lock.settled === null && !promptOwnsSend
  const sends = useMobileNativeChatOfflineSends(scope)
  const sendRef = useRef(send)
  sendRef.current = send
  const [draining, setDraining] = useState(false)
  const drainingRef = useRef(false)

  const dispatch = useCallback(
    async (target: string, queued: MobileNativeChatOfflineSend): Promise<boolean> => {
      drainingRef.current = true
      setDraining(true)
      // Out of the queue before it goes, so nothing can send it twice; a send that doesn't go comes back paused.
      removeMobileNativeChatOfflineSends(target, [queued.id])
      const putBack = () => returnMobileNativeChatOfflineSend(target, queued)
      let sent = false
      try {
        sent = await sendRef.current(queued.text, {
          ...(queued.alternate ? { alternate: true } : {}),
          ...(queued.goal ? { goal: true } : {}),
          queued,
          onHandBack: putBack
        })
      } finally {
        if (!sent) {
          putBack()
        }
        drainingRef.current = false
        setDraining(false)
      }
      return sent
    },
    []
  )

  const head = sends[0]
  useEffect(() => {
    if (ready && scope && !draining && head && !head.paused) {
      void dispatch(scope, head)
    }
  }, [dispatch, draining, head, ready, scope])

  const queueSend = useCallback<Send>(
    async (text, intent) => {
      const waiting = readMobileNativeChatOfflineSends(scope).some((queued) => !queued.paused)
      if (!scope || !(offline || waiting || drainingRef.current)) {
        return send(text, intent)
      }
      // The composer's chips go with the message, as a sent one takes them.
      const { images, files } = readMobileNativeChatDraftInputs(scope)
      queueMobileNativeChatOfflineSend(scope, {
        text,
        ...(intent?.alternate ? { alternate: true } : {}),
        ...(intent?.goal ? { goal: true } : {}),
        images,
        files,
        skills: readMobileNativeChatPickedSkills(scope),
        skillOrigin: readMobileNativeChatSkillOrigin(scope)
      })
      updateMobileNativeChatDraftInputs(scope, (current) => ({ ...current, images: [], files: [] }))
      setMobileNativeChatDraftText(scope, (current) => (current === text ? '' : current))
      return true
    },
    [offline, scope, send]
  )

  const sendNow = useCallback(
    async (id: string) => {
      const queued = readMobileNativeChatOfflineSends(scope).find((entry) => entry.id === id)
      if (!scope || !queued || !ready || drainingRef.current) {
        return false
      }
      return dispatch(scope, queued)
    },
    [dispatch, ready, scope]
  )

  const remove = useCallback(
    async (ids: string[]) => {
      if (scope) {
        removeMobileNativeChatOfflineSends(scope, ids)
      }
      return true
    },
    [scope]
  )

  const resume = useCallback(async () => {
    if (scope) {
      resumeMobileNativeChatOfflineSends(scope)
    }
    return true
  }, [scope])

  const edit = useCallback(
    async (id: string) => {
      const queued = readMobileNativeChatOfflineSends(scope).find((entry) => entry.id === id)
      if (!scope || !queued) {
        return false
      }
      removeMobileNativeChatOfflineSends(scope, [id])
      setMobileNativeChatDraftText(scope, (current) =>
        appendReturnedDraftText(current, queued.text)
      )
      returnMobileNativeChatDraftAttachments(
        mobileNativeChatDraftDestination(scope),
        queued.images,
        queued.files
      )
      restoreMobileNativeChatPickedSkills(scope, queued.skills)
      return true
    },
    [scope]
  )

  return {
    sends,
    composerLock: {
      disabled: lock.settled === 'waiting',
      offline: lock.settled === 'disconnected'
    },
    send: queueSend,
    sendNow,
    remove,
    resume,
    edit
  }
}
