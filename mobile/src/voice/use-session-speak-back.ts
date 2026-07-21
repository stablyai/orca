import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { onAgentTaskComplete } from '../notifications/agent-complete-signal'
import { summarizeForSpeech } from './summarize-for-speech'
import { useMeshSpeak } from './use-mesh-speak'

// Per-session speak-back for TERMINAL agents — the missing half of a spoken
// back-and-forth while you work.
//
// Why this is not A2a: A2a (MobileNativeChatOverlay) speaks replies for the
// NATIVE CHAT path, triggering off `NativeChatMessage` rows. An operator
// running a terminal agent (dictate into the composer, agent works in a PTY)
// never mounts that overlay and never produces those rows, so speak-back could
// not fire for them. This watches the feed terminal agents DO emit: Orca's
// agent-hook status, surfaced per-workspace on `worktree.ps`. When an agent
// goes working -> done, `lastAssistantMessage` carries what it said.
//
// Input direction is unchanged: native dictation already types into the
// terminal. This only adds the voice coming back.

// Poll cadence while armed. The agent-hook feed updates on hook events, not on
// our schedule, so this only bounds how late a finished turn is noticed.
const POLL_MS = 4000

export type SessionSpeakBack = {
  /** True while a reply is being folded down or spoken. */
  busy: boolean
  error: string | null
}

export function useSessionSpeakBack(options: {
  client: RpcClient | null
  worktreeId: string | null
  enabled: boolean
}): SessionSpeakBack {
  const { client, worktreeId, enabled } = options
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { speak } = useMeshSpeak()

  // Why refs: the poll loop must not restart on every render, and the spoken
  // set must survive re-renders so one finished turn is never spoken twice.
  const spokenRef = useRef<Set<string>>(new Set())
  const workingRef = useRef<Map<string, boolean>>(new Map())
  const speakRef = useRef(speak)
  speakRef.current = speak

  const handleAgentRow = useCallback((row: RuntimeWorktreeAgentRow) => {
    const wasWorking = workingRef.current.get(row.paneKey) === true
    const isWorking = row.state === 'working'
    workingRef.current.set(row.paneKey, isWorking)
    // Why 'done' specifically, not "any non-working state": 'waiting' means the
    // agent is asking the operator something and 'blocked' means it is stuck —
    // neither carries a finished reply. Measured 2026-07-21: a 'waiting'
    // transition reports lastAssistantMessage null.
    if (!wasWorking || row.state !== 'done') {
      return
    }
    const reply = row.lastAssistantMessage?.trim()
    if (!reply) {
      return
    }
    // Dedupe on the message itself: a repeated poll of the same 'done' row must
    // not re-speak it, and paneKey alone would suppress the NEXT real turn.
    const key = `${row.paneKey}:${reply.slice(0, 120)}`
    if (spokenRef.current.has(key)) {
      return
    }
    spokenRef.current.add(key)
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        speakRef.current(await summarizeForSpeech(reply))
      } catch (err) {
        // Why fall back to the raw reply: a summarizer outage should degrade to
        // "too long but audible", never to silence — silence is
        // indistinguishable from the feature being broken.
        setError(String(err instanceof Error ? err.message : err))
        speakRef.current(reply)
      } finally {
        setBusy(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!enabled || !client || !worktreeId) {
      // Why clear on disarm: re-arming later should not replay a turn that
      // finished while the toggle was off.
      workingRef.current.clear()
      return
    }
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const response = await client.sendRequest('worktree.ps', { limit: 10000 })
        if (cancelled || !response.ok) {
          return
        }
        // Why unwrap `.result`: sendRequest resolves the RPC ENVELOPE
        // ({ ok, result, _meta }), not the payload. Reading `.worktrees` off the
        // envelope silently yields undefined -> zero agents -> the feature
        // no-ops without an error, which is exactly how this shipped broken the
        // first time. Keep the `.result` hop explicit.
        const result = (response as RpcSuccess).result as {
          worktrees?: { worktreeId?: string; agents?: RuntimeWorktreeAgentRow[] }[]
        }
        const mine = result.worktrees?.find((w) => w.worktreeId === worktreeId)
        for (const row of mine?.agents ?? []) {
          handleAgentRow(row)
        }
      } catch {
        // Why swallow: a dropped poll is not worth a user-visible error. The
        // connection banner already reports real disconnects, and the next tick
        // recovers on its own.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    // Why also listen: the interval alone is throttled hard in the background
    // (measured gaps up to 62s), while the desktop's agent-task-complete push
    // arrives promptly on the live socket. Tick immediately on that push so a
    // finished turn is spoken when it happens, not on the next throttled wake.
    const unsubscribe = onAgentTaskComplete(() => {
      void tick()
    })
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [enabled, client, worktreeId, handleAgentRow])

  return { busy, error }
}
