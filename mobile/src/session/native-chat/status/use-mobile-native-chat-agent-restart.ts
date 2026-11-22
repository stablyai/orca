import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { nativeChatTerminalAgentRestart } from '../../../terminal/session/mobile-session-terminal-operations'
import { isResumableTuiAgent } from '../../../../../src/shared/agent-session/lifecycle/agent-session-resume'
import type {
  PaneAgentRestartMode,
  PaneAgentRestartRefusal
} from '../../../../../src/shared/native-chat/agent-presence/pane-agent-restart-contract'
import {
  useMobileNativeChatAgentPresence,
  type MobileNativeChatAgentPresence
} from './use-mobile-native-chat-agent-presence'

const AGENT_RESTART_READ_MS = 2_000
// Why: past this the agent never reported back; the notice keeps its buttons for another try.
const AGENT_RESTART_SETTLE_MS = 60_000
const AGENT_RESTART_REQUEST_TIMEOUT_MS = 20_000

export type MobileNativeChatAgentRestartPhase =
  | { kind: 'idle' }
  | { kind: 'restarting'; mode: PaneAgentRestartMode }
  | { kind: 'failed'; mode: PaneAgentRestartMode; reason: PaneAgentRestartRefusal }

export type MobileNativeChatAgentRestart = {
  phase: MobileNativeChatAgentRestartPhase
  /** The phone knows a session to name; the host can still refuse it. */
  canResume: boolean
  restart: (mode: PaneAgentRestartMode) => void
}

/** Asks the host to restart the chat's agent in its own terminal, then waits for it to run. */
export function useMobileNativeChatAgentRestart(args: {
  client: RpcClient | null
  terminal: string | null
  agent: string | null
  tracked: MobileNativeChatAgentPresence
}): MobileNativeChatAgentRestart {
  const { client, terminal, agent, tracked } = args
  const { presence, readNow, dismissRestart } = tracked
  const exited = presence.exit !== null
  const sessionId = presence.exit?.sessionId ?? presence.restartFrom?.sessionId ?? null
  const [phase, setPhase] = useState<MobileNativeChatAgentRestartPhase>({ kind: 'idle' })
  // An agent coming back settles a restart; a new exit or terminal starts clean.
  const [seen, setSeen] = useState({ exited, terminal })
  if (seen.exited !== exited || seen.terminal !== terminal) {
    setSeen({ exited, terminal })
    setPhase({ kind: 'idle' })
  }
  const restart = useCallback(
    (mode: PaneAgentRestartMode) => {
      if (!client || !terminal || !agent) {
        setPhase({ kind: 'failed', mode, reason: 'pane_unavailable' })
        return
      }
      setPhase({ kind: 'restarting', mode })
      void nativeChatTerminalAgentRestart
        .request(
          client,
          { terminal, mode, agent, sessionId, transcriptPath: null },
          { timeoutMs: AGENT_RESTART_REQUEST_TIMEOUT_MS }
        )
        .then((response) => {
          const verdict = nativeChatTerminalAgentRestart.interpret(response)
          const result = verdict.accepted
            ? verdict.value
            : { ok: false as const, reason: 'failed' as const }
          if (!result.ok) {
            setPhase({ kind: 'failed', mode, reason: result.reason })
          } else if (!exited) {
            setPhase({ kind: 'idle' })
            dismissRestart()
          }
        })
        .catch(() => setPhase({ kind: 'failed', mode, reason: 'failed' }))
    },
    [client, terminal, agent, sessionId, exited, dismissRestart]
  )
  useEffect(() => {
    if (phase.kind !== 'restarting') {
      return
    }
    const reads = setInterval(readNow, AGENT_RESTART_READ_MS)
    const settle = setTimeout(
      () => setPhase({ kind: 'failed', mode: phase.mode, reason: 'failed' }),
      AGENT_RESTART_SETTLE_MS
    )
    return () => {
      clearInterval(reads)
      clearTimeout(settle)
    }
  }, [phase, readNow])
  const canResume = sessionId !== null && agent !== null && isResumableTuiAgent(agent)
  return useMemo(() => ({ phase, canResume, restart }), [phase, canResume, restart])
}

/** The chat's agent presence, with the restart its notice offers. */
export function useMobileNativeChatTrackedAgent(
  args: Parameters<typeof useMobileNativeChatAgentPresence>[0] & { agent: string | null }
): MobileNativeChatAgentPresence {
  const tracked = useMobileNativeChatAgentPresence(args)
  const restart = useMobileNativeChatAgentRestart({
    client: args.client,
    terminal: args.terminal,
    agent: args.agent,
    tracked
  })
  return useMemo(() => ({ ...tracked, restart }), [tracked, restart])
}
