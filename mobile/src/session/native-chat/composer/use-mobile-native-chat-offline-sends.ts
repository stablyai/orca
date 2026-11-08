import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { appendReturnedDraftText } from '../../../../../src/shared/returned-draft-text'
import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'
import type { MobileNativeChatInputLockReason } from '../MobileNativeChatView'
import { useSettledMobileNativeChatInputLock } from '../use-mobile-native-chat-input-lease'
import {
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  returnMobileNativeChatDraftAttachments,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import {
  readMobileNativeChatPickedSkills,
  readMobileNativeChatSkillOrigin,
  recordMobileNativeChatSkillPick,
  restoreMobileNativeChatPickedSkills,
  setMobileNativeChatDraftText
} from './mobile-native-chat-draft-store'
import {
  beginMobileNativeChatOfflineSend,
  queueMobileNativeChatOfflineSend,
  settleMobileNativeChatOfflineSend,
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
  /** The chat can take a queued message now. */
  ready: boolean
  /** The lock the composer shows, settled so a blink doesn't flash it. */
  lockReason: MobileNativeChatInputLockReason | null
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
  /** The input lock as the chat reports it; the queue settles it for the composer too. */
  inputLockReason: MobileNativeChatInputLockReason | null
  /** Not yet: a structured chat hasn't loaded its session (no fence to send with), or a terminal agent waits on a prompt, shown or folded away, that queued text would answer. */
  held: boolean
  send: Send
}): MobileNativeChatOfflineQueue {
  const { scope, inputLockReason, held, send } = args
  const lockReason = useSettledMobileNativeChatInputLock(inputLockReason)
  const offline = inputLockReason === 'disconnected'
  // Wait out the settle too, so a connection that blinks back doesn't send into a stale chat.
  const ready = inputLockReason === null && lockReason === null && !held
  const sends = useMobileNativeChatOfflineSends(scope)
  const sendRef = useRef(send)
  useLayoutEffect(() => {
    sendRef.current = send
  }, [send])
  const [draining, setDraining] = useState(false)
  const drainingRef = useRef(false)

  const dispatch = useCallback(
    async (target: string, queued: MobileNativeChatOfflineSend): Promise<boolean> => {
      drainingRef.current = true
      setDraining(true)
      // Marked on its way, so nothing sends it twice; it keeps its place (and its saved copy) until the send settles.
      beginMobileNativeChatOfflineSend(target, queued.id)
      // A tab closed meanwhile took its queue with it; a late answer must not bring one back.
      const destination = mobileNativeChatDraftDestination(target)
      let handedBack = false
      const putBack = () => {
        handedBack = true
        if (destination.active) {
          returnMobileNativeChatOfflineSend(target, queued)
        }
      }
      let sent = false
      try {
        sent = await sendRef.current(queued.text, {
          ...(queued.alternate ? { alternate: true } : {}),
          ...(queued.goal ? { goal: true } : {}),
          queued,
          onHandBack: putBack
        })
      } finally {
        // A hand-back during the send (a lost command reply) already returned it paused; keep it.
        settleMobileNativeChatOfflineSend(target, queued.id, sent && !handedBack)
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
      // Behind anything already queued, paused or not, so messages reach the agent in the order sent.
      const waiting = readMobileNativeChatOfflineSends(scope).length > 0
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
      let restored = ''
      setMobileNativeChatDraftText(scope, (current) => {
        restored = appendReturnedDraftText(current, queued.text)
        return restored
      })
      returnMobileNativeChatDraftAttachments(
        mobileNativeChatDraftDestination(scope),
        queued.images,
        queued.files
      )
      restoreMobileNativeChatPickedSkills(scope, queued.skills)
      // A picked skill leading the text still reads as chat, as it did when queued.
      const origin = queued.skillOrigin
      if (origin && restored.split(/\s/, 1)[0] === origin) {
        const path = queued.skills.find((skill) => skill.name === origin.slice(1))?.path
        recordMobileNativeChatSkillPick(scope, { token: origin, ...(path ? { path } : {}) })
      }
      return true
    },
    [scope]
  )

  return {
    sends,
    ready,
    lockReason,
    composerLock: {
      disabled: lockReason === 'waiting',
      offline: lockReason === 'disconnected'
    },
    send: queueSend,
    sendNow,
    remove,
    resume,
    edit
  }
}
