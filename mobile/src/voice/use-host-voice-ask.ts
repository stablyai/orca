import { useCallback, useMemo, useRef, useState } from 'react'
import { useMobileDictation } from '../hooks/use-mobile-dictation'
import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-types'
import { askHerm } from './ask-herm'
import { useMeshSpeak } from './use-mesh-speak'
import type { HostVoicePhase } from '../components/HostVoiceFab'

// A2b — hold-to-talk on the host panel. Wires the three pieces that already
// exist rather than inventing a fourth:
//   mic     -> useMobileDictation (Orca native, on-device Parakeet). Confirmed
//              working on the Nord. We do NOT reimplement STT.
//   brain   -> askHerm (mesh LiteLLM :4000, workspace context)
//   speaker -> useMeshSpeak (mesh Kokoro, the genuine delta over native voice)
//
// Scope guard: this asks ABOUT the fleet, it never injects into a terminal.
// Per-session dictation in the composer remains the "type into this agent"
// path and is untouched.

// Cap the context sent to the arm: a 60-workspace host would blow the prompt
// budget for no gain when the question is "what's running".
const MAX_CONTEXT_WORKSPACES = 40

export type HostVoiceAsk = {
  phase: HostVoicePhase
  /** Last transcript + answer, for the on-screen transcript strip. */
  lastQuestion: string | null
  lastAnswer: string | null
  error: string | null
  onPressIn: () => void
  onPressOut: () => void
}

export function useHostVoiceAsk(options: {
  client: RpcClient | null
  hostName: string
  hostEndpoint?: string | null
  worktrees: Worktree[]
  enabled: boolean
}): HostVoiceAsk {
  const { client, hostName, hostEndpoint, worktrees, enabled } = options
  const [thinking, setThinking] = useState(false)
  const [lastQuestion, setLastQuestion] = useState<string | null>(null)
  const [lastAnswer, setLastAnswer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { speak, isSpeaking } = useMeshSpeak({ hostEndpoint })
  const hostEndpointRef = useRef(hostEndpoint)
  hostEndpointRef.current = hostEndpoint

  // Why: read context at answer time via a ref — capturing `worktrees` in the
  // dictation callback would re-create the hook on every worktree poll and
  // cancel an in-flight recording.
  const contextRef = useRef({ hostName, worktrees })
  contextRef.current = { hostName, worktrees }

  const onTranscript = useCallback(
    (text: string) => {
      const question = text.trim()
      if (!question) {
        return
      }
      setLastQuestion(question)
      setLastAnswer(null)
      setError(null)
      setThinking(true)
      void (async () => {
        try {
          const { hostName: name, worktrees: rows } = contextRef.current
          const answer = await askHerm(
            question,
            {
              hostName: name,
              // Why this much: `worktree.ps` already streams live agent state to
              // this client over the authenticated host connection, so Herm can
              // be told what each agent was asked to do and what it is doing
              // right now. Sending only titles was why Herm sounded like it had
              // never seen the host.
              workspaces: rows.slice(0, MAX_CONTEXT_WORKSPACES).map((w) => ({
                title: w.displayName || w.branch,
                repo: w.repo,
                branch: w.branch,
                status: w.workspaceStatus ?? (w.hasAttachedPty ? 'agent attached' : null),
                liveTerminalCount: w.liveTerminalCount,
                agents: (w.agents ?? []).map((a) => ({
                  state: a.state,
                  agentType: a.agentType,
                  prompt: a.prompt,
                  taskTitle: a.taskTitle,
                  lastAssistantMessage: a.lastAssistantMessage,
                  toolName: a.toolName,
                  interrupted: a.interrupted
                }))
              }))
            },
            { hostEndpoint: hostEndpointRef.current }
          )
          setLastAnswer(answer)
          speak(answer)
        } catch (err) {
          setError(String(err instanceof Error ? err.message : err))
        } finally {
          setThinking(false)
        }
      })()
    },
    [speak]
  )

  const onError = useCallback((err: Error) => setError(err.message), [])

  const dictation = useMobileDictation({ client, enabled, onTranscript, onError })

  const onPressIn = useCallback(() => {
    setError(null)
    void dictation.start()
  }, [dictation])

  // Why: stop() is what produces the transcript, so a press-out while merely
  // 'starting' must still stop — otherwise a quick tap leaves the mic open.
  const onPressOut = useCallback(() => {
    void dictation.stop()
  }, [dictation])

  const phase: HostVoicePhase = useMemo(() => {
    if (dictation.isRecording || dictation.isStarting) {
      return 'recording'
    }
    if (thinking || dictation.isProcessing) {
      return 'thinking'
    }
    if (isSpeaking) {
      return 'speaking'
    }
    return 'idle'
  }, [dictation.isRecording, dictation.isStarting, dictation.isProcessing, thinking, isSpeaking])

  return { phase, lastQuestion, lastAnswer, error, onPressIn, onPressOut }
}
