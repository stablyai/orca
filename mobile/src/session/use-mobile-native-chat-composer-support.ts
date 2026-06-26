import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { DiscoveredSkill } from '../../../src/shared/skills'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { isSlashCommandDraft } from '../../../src/shared/native-chat-slash-commands'

// Composer support for the mobile native chat: the lazily-loaded `@file` and
// `$skill` suggestion sources, the message-send handler, the optimistic
// "queued" pending bubbles, and Stop/interrupt. Extracted from the session route
// to keep that file under its line cap and to keep this cohesive composer surface
// in one place.

type DeviceClientField = { client: { id: string; type: 'mobile' } } | Record<string, never>

export type MobileNativeChatPending = { id: string; text: string }

export type MobileNativeChatComposerSupport = {
  /** File paths for `@` mention autocomplete (empty until first loaded). */
  filePaths: string[]
  /** Lazily fetch worktree files the first time the user opens a mention. */
  loadFiles: () => void
  /** Discovered skills for `$` autocomplete (Codex only; empty otherwise). */
  skills: DiscoveredSkill[]
  /** Lazily discover skills the first time the user opens a `$` token. */
  loadSkills: () => void
  /** Send composer text to the agent. Suppresses the optimistic bubble for slash
   *  commands (control actions, not chat turns). */
  send: (text: string) => void
  /** Optimistic queued sends, shown until the agent's real turn lands. */
  pending: MobileNativeChatPending[]
  /** Interrupt the agent mid-turn (Stop button). */
  stop: () => void
  /** Open a worktree file tapped in agent markdown. */
  openFile: (relativePath: string) => void
}

export function useMobileNativeChatComposerSupport(args: {
  client: RpcClient | null
  worktreeId: string
  deviceTokenRef: MutableRefObject<string | null>
  activeHandleRef: MutableRefObject<string | null>
  activeChatAgentRef: MutableRefObject<string | null>
  /** The live transcript — used to drop a queued echo once its real turn lands. */
  messages: NativeChatMessage[]
  /** Changes on chat session swap; clears pending echoes when it does. */
  sessionId: string | null
  /** Drop in-flight per-question answer writes so Stop doesn't race them. */
  cancelAnswer: () => void
}): MobileNativeChatComposerSupport {
  const {
    client,
    worktreeId,
    deviceTokenRef,
    activeHandleRef,
    activeChatAgentRef,
    messages,
    sessionId,
    cancelAnswer
  } = args

  const clientField = (): DeviceClientField =>
    deviceTokenRef.current
      ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
      : {}

  const [pending, setPending] = useState<MobileNativeChatPending[]>([])
  const pendingCounter = useRef(0)
  // Reset queued echoes when the chat session swaps (tab switch starts fresh).
  useEffect(() => {
    setPending([])
  }, [sessionId])
  // Drop a queued echo once its real user turn lands in the transcript.
  useEffect(() => {
    setPending((prev) =>
      prev.length === 0
        ? prev
        : prev.filter(
            (p) =>
              !messages.some(
                (m) =>
                  m.role === 'user' &&
                  m.blocks.some((b) => b.type === 'text' && b.text.trim() === p.text.trim())
              )
          )
    )
  }, [messages])

  const [filePaths, setFilePaths] = useState<string[]>([])
  const filesLoadedRef = useRef(false)
  const loadFiles = useCallback(() => {
    if (filesLoadedRef.current || !client) {
      return
    }
    filesLoadedRef.current = true
    void client
      .sendRequest('files.list', { worktree: `id:${worktreeId}` })
      .then((response) => {
        if (!response.ok) {
          return
        }
        const result = response.result as { files?: Array<{ relativePath?: string }> }
        setFilePaths(
          (result.files ?? [])
            .map((f) => f.relativePath ?? '')
            .filter((p): p is string => p.length > 0)
        )
      })
      .catch(() => {
        filesLoadedRef.current = false
      })
  }, [client, worktreeId])

  const [skills, setSkills] = useState<DiscoveredSkill[]>([])
  const skillsLoadedRef = useRef(false)
  const loadSkills = useCallback(() => {
    // Codex-only — Claude has no skill discovery, so the menu stays empty there.
    if (skillsLoadedRef.current || !client || activeChatAgentRef.current !== 'codex') {
      return
    }
    skillsLoadedRef.current = true
    // No cwd → runtime discovers across its repos (the handler's designed
    // fallback); avoids resolving a worktree path just for the `$` menu.
    void client
      .sendRequest('skills.discover', {})
      .then((response) => {
        if (!response.ok) {
          skillsLoadedRef.current = false
          return
        }
        const result = response.result as { skills?: DiscoveredSkill[] }
        setSkills(result.skills ?? [])
      })
      .catch(() => {
        skillsLoadedRef.current = false
      })
  }, [client, activeChatAgentRef])

  const send = useCallback(
    (text: string) => {
      const handle = activeHandleRef.current
      if (!client || !handle) {
        return
      }
      // Submit as one bracketed paste + Enter so multi-line composer input reaches
      // the agent as a single prompt, mirroring terminal.send usage.
      void client
        .sendRequest('terminal.send', { terminal: handle, text, enter: true, ...clientField() })
        .catch(() => {
          // Transient send failure; the composer keeps the conversation visible.
        })
      // Optimistic echo so the prompt shows immediately as "queued" — but NOT for
      // slash commands. Those are control actions (e.g. /clear, /model) dispatched
      // to the agent's TUI, not chat turns, so a fake user bubble would be wrong.
      if (isSlashCommandDraft(text)) {
        return
      }
      pendingCounter.current += 1
      setPending((prev) => [...prev, { id: `pending-${pendingCounter.current}`, text }])
    },
    // clientField reads deviceTokenRef.current at call time, so it isn't a dep.
    [client, activeHandleRef]
  )

  // Interrupt the current turn. TUI agents (Claude Code, Codex) cancel on Escape —
  // not Ctrl-C, which tends to quit/clear the prompt. Send Escape twice to
  // reliably cancel an in-progress generation.
  const stop = useCallback(() => {
    const handle = activeHandleRef.current
    if (!client || !handle) {
      return
    }
    cancelAnswer()
    const escape = String.fromCharCode(27)
    const sendEscape = (): void => {
      void client.sendRequest('terminal.send', { terminal: handle, text: escape, ...clientField() })
    }
    sendEscape()
    setTimeout(sendEscape, 80)
    // clientField reads deviceTokenRef.current at call time, so it isn't a dep.
  }, [client, activeHandleRef, cancelAnswer])

  const openFile = useCallback(
    (relativePath: string) => {
      if (!client) {
        return
      }
      void client.sendRequest('files.open', { worktree: `id:${worktreeId}`, relativePath })
    },
    [client, worktreeId]
  )

  return { filePaths, loadFiles, skills, loadSkills, send, pending, stop, openFile }
}
