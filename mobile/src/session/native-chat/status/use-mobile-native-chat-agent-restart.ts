import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  /** `sessionId` is set when a running agent is replaced: done once the chat shows that session. */
  | { kind: 'restarting'; mode: PaneAgentRestartMode; sessionId?: string }
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
  /** The conversation the chat shows now. */
  shownSessionId: string | null
  tracked: MobileNativeChatAgentPresence
}): MobileNativeChatAgentRestart {
  const { client, terminal, agent, shownSessionId, tracked } = args
  const { presence, readNow, dismissRestart } = tracked
  const exited = presence.exit !== null
  const sessionId = presence.exit?.sessionId ?? presence.restartFrom?.sessionId ?? null
  const [phase, setPhase] = useState<MobileNativeChatAgentRestartPhase>({ kind: 'idle' })
  // Only the newest request on this terminal may report back.
  const operationRef = useRef(0)
  // A new exit drops the last failure; a restart in flight rides through its own stop; a new terminal starts clean.
  const [seen, setSeen] = useState({ exited, terminal })
  if (seen.exited !== exited || seen.terminal !== terminal) {
    setSeen({ exited, terminal })
    if (seen.terminal !== terminal || phase.kind === 'failed') {
      setPhase({ kind: 'idle' })
    }
  }
  useEffect(() => {
    operationRef.current += 1
  }, [terminal])
  const settled =
    phase.kind === 'restarting' &&
    !exited &&
    (phase.sessionId === undefined || phase.sessionId === shownSessionId)
  // Both setters belong to this component's own hooks, so they may run during render.
  if (settled) {
    setPhase({ kind: 'idle' })
    if (phase.sessionId !== undefined) {
      dismissRestart()
    }
  }
  const restart = useCallback(
    (mode: PaneAgentRestartMode) => {
      const operation = ++operationRef.current
      const report = (next: MobileNativeChatAgentRestartPhase): void => {
        if (operationRef.current === operation) {
          setPhase(next)
        }
      }
      if (!client || !terminal || !agent) {
        report({ kind: 'failed', mode, reason: 'pane_unavailable' })
        return
      }
      // Replacing a running agent: wait for the chat to show the resumed conversation.
      report(
        !exited && mode === 'resume' && sessionId
          ? { kind: 'restarting', mode, sessionId }
          : { kind: 'restarting', mode }
      )
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
            report({ kind: 'failed', mode, reason: result.reason })
          }
        })
        .catch(() => report({ kind: 'failed', mode, reason: 'failed' }))
    },
    [client, terminal, agent, sessionId, exited]
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
    shownSessionId: args.sessionId,
    tracked
  })
  return useMemo(() => ({ ...tracked, restart }), [tracked, restart])
}
