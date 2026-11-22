import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { nativeChatTerminalAgentRunningRead } from '../../../terminal/session/mobile-session-terminal-operations'
import type { MobileNativeChatAgentRestart } from './use-mobile-native-chat-agent-restart'
import {
  NATIVE_CHAT_AGENT_PRESENT,
  nextNativeChatAgentPresence,
  type NativeChatAgentPresence
} from '../../../../../src/shared/native-chat/agent-presence/native-chat-agent-presence'

const AGENT_PRESENCE_POLL_MS = 10_000
const AGENT_PRESENCE_READ_TIMEOUT_MS = 5_000
// Why: a launching agent can read as a bare shell once; an agent seen running needs no second look.
const UNSEEN_AGENT_GONE_READS = 2

export type MobileNativeChatAgentPresence = {
  presence: NativeChatAgentPresence
  dismissRestart: () => void
  /** Asks the host again now, e.g. while a restart waits for the agent. */
  readNow: () => void
  restart?: MobileNativeChatAgentRestart
}

/** Asks the host whether an agent still runs in a terminal chat's pane, while the chat is shown. */
export function useMobileNativeChatAgentPresence(args: {
  client: RpcClient | null
  /** The chat's terminal; null for structured chats. */
  terminal: string | null
  /** Reads only while the chat is shown and its host is reachable. */
  active: boolean
  /** Changes when the pane's agent state or session does, prompting a fresh read. */
  statusKey: string
  sessionId: string | null
}): MobileNativeChatAgentPresence {
  const { client, terminal, active, statusKey } = args
  const [presence, setPresence] = useState<NativeChatAgentPresence>(NATIVE_CHAT_AGENT_PRESENT)
  const sessionIdRef = useRef(args.sessionId)
  useLayoutEffect(() => {
    sessionIdRef.current = args.sessionId
  }, [args.sessionId])
  const readsRef = useRef({ terminal, seenRunning: false, goneReads: 0 })
  const readNowRef = useRef<() => void>(() => {})
  const [trackedTerminal, setTrackedTerminal] = useState(terminal)
  if (trackedTerminal !== terminal) {
    setTrackedTerminal(terminal)
    setPresence(NATIVE_CHAT_AGENT_PRESENT)
  }

  useEffect(() => {
    if (!client || !terminal || !active) {
      return
    }
    if (readsRef.current.terminal !== terminal) {
      readsRef.current = { terminal, seenRunning: false, goneReads: 0 }
    }
    let disposed = false
    // Reads overlap while a restart polls; an older answer must not overwrite a newer one.
    let issuedReads = 0
    let appliedRead = 0
    const read = async (): Promise<void> => {
      const sequence = ++issuedReads
      let running: boolean
      try {
        const response = await nativeChatTerminalAgentRunningRead.request(
          client,
          { terminal },
          { timeoutMs: AGENT_PRESENCE_READ_TIMEOUT_MS }
        )
        const verdict = nativeChatTerminalAgentRunningRead.interpret(response)
        if (!verdict.accepted) {
          return
        }
        running = verdict.value
      } catch {
        // An unanswered read is no evidence either way.
        return
      }
      const reads = readsRef.current
      if (disposed || reads.terminal !== terminal || sequence < appliedRead) {
        return
      }
      appliedRead = sequence
      reads.goneReads = running ? 0 : reads.goneReads + 1
      reads.seenRunning ||= running
      const agentGone =
        !running && reads.goneReads >= (reads.seenRunning ? 1 : UNSEEN_AGENT_GONE_READS)
      setPresence((current) =>
        nextNativeChatAgentPresence(current, {
          agentGone,
          agentRunning: running,
          sessionId: sessionIdRef.current,
          now: Date.now()
        })
      )
    }
    readNowRef.current = () => void read()
    void read()
    const timer = setInterval(() => void read(), AGENT_PRESENCE_POLL_MS)
    return () => {
      disposed = true
      readNowRef.current = () => {}
      clearInterval(timer)
    }
  }, [client, terminal, active, statusKey])

  const dismissRestart = useCallback(
    () =>
      setPresence((current) => (current.restartFrom ? { ...current, restartFrom: null } : current)),
    []
  )
  const readNow = useCallback(() => readNowRef.current(), [])
  return useMemo(() => ({ presence, dismissRestart, readNow }), [presence, dismissRestart, readNow])
}
