import { useCallback, useRef, useState, type RefObject } from 'react'
import { isTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { AI_VAULT_CHAT_FORK_EXPORT_CAPABILITY } from '../../../../src/shared/ai-vault/resume/ai-vault-resume-preparation'
import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { useRpcClientContext } from '../../transport/connection/client-context'
import { mobileSubagentForkAvailable } from '../mobile-structured-chat-worktree-fork'
import type { MobileNativeChatFork } from '../native-chat/use-mobile-native-chat-fork'
import type { MobileSessionController } from '../use-mobile-session-controller'
import { useOpenMobileSession } from '../use-open-mobile-session'
import { chatForkCopy } from './chat-fork-copy'
import { runChatFork, type ChatForkRunDeps, type ChatForkRunTarget } from './chat-fork-run'
import type { ChatForkPreset } from './chat-fork-selection'
import { MobileChatForkSheet, type MobileChatForkSheetSource } from './MobileChatForkSheet'

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
  const open = useCallback((message: NativeChatMessage, preset: ChatForkPreset = null) => {
    if (!busyRef.current) {
      setRequest({ message, preset, visible: true })
    }
  }, [])
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
  const confirm = useCallback(
    (target: ChatForkRunTarget) => {
      const current = latestController.current
      const message = request?.message
      const agent = current.nativeChatController.nativeChatAgent
      if (!message || busyRef.current || !agent || !isTuiAgent(agent)) {
        return
      }
      // A copy beside this chat or into a new worktree has its own prompts; close first for them.
      const keepOpen = target.workspace.kind === 'existing'
      const started = fork.forkWith(message, async (_agent, forkFrom) => {
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
              title: current.activeSessionTab?.title || undefined,
              messages: current.nativeChatController.nativeChatSession.messages
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
          current.showToast(
            chatForkCopy.failed(TUI_AGENT_DISPLAY_NAMES[target.agent], detail),
            4000
          )
        } finally {
          busyRef.current = false
          setBusy(false)
          setProgress(null)
          close()
        }
      })
      if (!started) {
        close()
        current.showToast(chatForkCopy.notNow(), 3000)
      }
    },
    [
      acquireHost,
      close,
      createFork,
      createWorktreeFork,
      fork,
      latestController,
      openMobileSession,
      request
    ]
  )
  const { controller } = input
  const agent = controller.nativeChatController.nativeChatAgent
  if (!request || !agent || !isTuiAgent(agent)) {
    return { open, sheet: null }
  }
  const capabilities = controller.hostCapabilities
  const terminal = controller.activeSessionTab?.type === 'terminal'
  const source: MobileChatForkSheetSource = {
    hostId: controller.hostId,
    worktreeId: controller.worktreeId,
    client: controller.client,
    capabilities,
    agent,
    usageLimited: controller.nativeChatController.nativeChatUsageLimit !== null,
    // A workspace routed to another server exports from there; this phone can't reach it directly.
    canExport:
      !executionHost &&
      agent === 'claude' &&
      capabilities?.includes(AI_VAULT_CHAT_FORK_EXPORT_CAPABILITY) === true,
    canNewWorktree: fork.worktreeForkOffered(),
    canSubagent: !terminal && mobileSubagentForkAvailable(capabilities)
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
