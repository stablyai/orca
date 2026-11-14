import { useEffect, useReducer, useState } from 'react'
import {
  peekStoredChatTranscript,
  readStoredChatTranscript
} from './mobile-native-chat-transcript-store'
import { flushChatTranscript } from './mobile-native-chat-transcript-writer'

// The same cap the boot read has: past it, the chat reads live without its stored copy.
const STORE_READ_WAIT_MS = 150

export function useChatTranscriptStoreReadWait(identity: string | null, waiting: boolean): boolean {
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null)
  const reading = waiting && identity !== null && gaveUpOn !== identity
  useEffect(() => {
    if (!reading || identity === null) {
      return
    }
    const wait = setTimeout(() => setGaveUpOn(identity), STORE_READ_WAIT_MS)
    return () => clearTimeout(wait)
  }, [identity, reading])
  return reading
}

/**
 * A chat's link to the phone's stored copy. Returns true while the copy is still being read (a few ms, then
 * one re-render), so the chat subscribes only once it can paint and resume from it. The copy the chat noted
 * is written when its turn settles and when the chat closes; the store writes on hidden itself.
 */
export function useStoredChatTranscript(args: {
  identity: string | null
  // False when this page already holds the chat, so there is nothing to read.
  read: boolean
  turnSettled: boolean
}): boolean {
  const { identity, turnSettled } = args
  const reading = useChatTranscriptStoreReadWait(
    identity,
    args.read && identity !== null && peekStoredChatTranscript(identity) === undefined
  )
  const [, answered] = useReducer((answers: number) => answers + 1, 0)
  useEffect(() => {
    if (!reading || identity === null) {
      return
    }
    let current = true
    void readStoredChatTranscript(identity).then(() => current && answered())
    return () => {
      current = false
    }
  }, [identity, reading])
  useEffect(() => {
    if (turnSettled && identity !== null) {
      flushChatTranscript(identity)
    }
  }, [identity, turnSettled])
  useEffect(
    () => () => {
      if (identity !== null) {
        flushChatTranscript(identity)
      }
    },
    [identity]
  )
  return reading
}
