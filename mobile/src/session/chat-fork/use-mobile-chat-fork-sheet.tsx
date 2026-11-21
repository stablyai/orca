import { useCallback, useRef, useState, type RefObject } from 'react'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { StructuredAgentSessionForkSource } from '../../../../src/shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { useRpcClientContext } from '../../transport/connection/client-context'
import type { MobileNativeChatFork } from '../native-chat/history/use-mobile-native-chat-fork'
import type { MobileSessionController } from '../use-mobile-session-controller'
import { useOpenMobileSession } from '../use-open-mobile-session'
import { chatForkCopy } from './chat-fork-copy'
import { runChatFork, type ChatForkRunDeps, type ChatForkRunTarget } from './chat-fork-run'
import type { ChatForkPreset } from './chat-fork-selection'
import { chatForkRecapOf, chatForkSheetSource } from './chat-fork-sheet-source'
import { useChatForkShellHandoff } from './use-chat-fork-shell-handoff'
import { MobileChatForkSheet } from './MobileChatForkSheet'

type SheetRequest = { message: NativeChatMessage; preset: ChatForkPreset; visible: boolean }

/** The open chat's Fork sheet: which response it forks from, and the run its Fork button starts. */
export function useMobileChatForkSheet(input: {
  fork: MobileNativeChatFork
  controller: MobileSessionController
  /** Read at the press: the controller is rebuilt each render. */
  latestController: RefObject<MobileSessionController>
  createFork: ChatForkRunDeps['createFork']
  createWorktreeFork: ChatForkRunDeps['createWorktreeFork']
  executionHost: ExecutionHostId | undefined
}): {
  open: (message: NativeChatMessage, preset?: ChatForkPreset) => void
  sheet: React.JSX.Element | null
} {
  const { fork, latestController, createFork, createWorktreeFork, executionHost } = input
  const [request, setRequest] = useState<SheetRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const busyRef = useRef(false)
  const ctx = useRpcClientContext()
  const openMobileSession = useOpenMobileSession()
  const close = useCallback(
    () => setRequest((current) => (current ? { ...current, visible: false } : null)),
    []
  )
  const acquireHost = useCallback(
    (hostId: string) => {
      const acquisition = {}
      const client = ctx.acquire(hostId, acquisition)
      return { client, release: () => ctx.release(hostId, acquisition) }
    },
    [ctx]
  )
  /** Runs a fork the sheet chose on this chat's host; the caller holds the fork gate. */
  const runHere = useCallback(
    async (
      agent: TuiAgent,
      target: ChatForkRunTarget,
      forkFrom: StructuredAgentSessionForkSource
    ): Promise<void> => {
      const current = latestController.current
      // The sheet's own paths beside this chat, and a new worktree's prompts, close it first; a fork
      // copied or launched through this sheet keeps it open to show progress.
      const ownPath =
        target.path === 'same' || (target.path === 'recap' && target.openAs === 'chat')
      const keepOpen =
        target.workspace.kind === 'existing' || (target.workspace.kind === 'this' && !ownPath)
      busyRef.current = true
      setBusy(keepOpen)
      if (!keepOpen) {
        close()
      }
      try {
        await runChatFork(
          {
            client: current.client,
            hostId: current.hostId,
            worktreeId: current.worktreeId,
            agent,
            terminal: current.activeSessionTab?.type === 'terminal',
            recap: chatForkRecapOf(current, agent)
          },
          {
            createFork,
            createWorktreeFork,
            acquireHost,
            openSession: (hostId, worktreeId, name) =>
              openMobileSession({ hostId, worktreeId, name }),
            onProgress: setProgress,
            showToast: current.showToast
          },
          target,
          forkFrom
        )
      } catch (error) {
        // runChatFork reports its own launch outcomes; a throw past it is a plain failure.
        const detail = error instanceof Error ? error.message.trim() : ''
        current.showToast(chatForkCopy.failed(TUI_AGENT_DISPLAY_NAMES[target.agent], detail), 4000)
      } finally {
        busyRef.current = false
        setBusy(false)
        setProgress(null)
        close()
      }
    },
    [acquireHost, close, createFork, createWorktreeFork, latestController, openMobileSession]
  )
  const shellSheet = useChatForkShellHandoff({ fork, latestController, executionHost, runHere })
  const open = useCallback(
    (message: NativeChatMessage, preset: ChatForkPreset = null) => {
      if (busyRef.current) {
        return
      }
      // In the served page the app's own sheet lists every paired host; this one knows only its own.
      if (shellSheet) {
        shellSheet(message, preset)
        return
      }
      setRequest({ message, preset, visible: true })
    },
    [shellSheet]
  )
  const confirm = useCallback(
    (target: ChatForkRunTarget) => {
      const current = latestController.current
      const message = request?.message
      const agent = current.nativeChatController.nativeChatAgent
      if (!message || busyRef.current || !agent || !isTuiAgent(agent)) {
        return
      }
      const kind = target.path === 'recap' ? 'recap' : 'copy'
      const started = fork.forkWith(
        message,
        (_agent, forkFrom) => runHere(agent, target, forkFrom),
        kind
      )
      if (!started) {
        close()
        current.showToast(chatForkCopy.notNow(), 3000)
      }
    },
    [close, fork, latestController, request, runHere]
  )
  const source = request ? chatForkSheetSource(input.controller, fork, executionHost) : null
  if (!request || !source) {
    return { open, sheet: null }
  }
  return {
    open,
    sheet: (
      <MobileChatForkSheet
        key={request.message.id}
        visible={request.visible}
        preset={request.preset}
        source={source}
        busy={busy}
        progress={progress}
        onConfirm={confirm}
        onClose={close}
        onAfterClose={() => setRequest((current) => (current?.visible ? current : null))}
      />
    )
  }
}
