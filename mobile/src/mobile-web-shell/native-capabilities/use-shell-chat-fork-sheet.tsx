import { useCallback, useEffect, useRef, useState } from 'react'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import {
  BRIDGE_CHAT_FORK_VERB,
  chatForkParamsSchema,
  type BridgeChatForkParams,
  type BridgeChatForkResult
} from '../bridge/native-capabilities/bridge-chat-fork-verb'
import { chatForkCopy } from '../../session/chat-fork/chat-fork-copy'
import {
  runChatFork,
  type ChatForkRunDeps,
  type ChatForkRunTarget
} from '../../session/chat-fork/chat-fork-run'
import { MobileChatForkSheet } from '../../session/chat-fork/MobileChatForkSheet'
import { useNativeDeviceVerbs, type NativeDeviceVerb } from '../../platform/use-native-device-verbs'
import { useOpenMobileSession } from '../../session/use-open-mobile-session'
import { useRpcClientContext } from '../../transport/connection/client-context'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

type Pending = {
  params: BridgeChatForkParams
  settle: (result: BridgeChatForkResult) => void
  visible: boolean
}

const MAX_NOTICES = 8
const MAX_NOTICE_CHARS = 1024

// Only the page can fork beside its chat or into a new worktree there; this sheet runs other hosts.
const pageOnly = (): Promise<never> =>
  Promise.reject(new Error('a fork on the page’s own host runs in the page'))

/** The served page's Fork sheet, drawn by the app over it with every paired host. */
export function useShellChatForkSheet(
  hostId: string,
  sessionId: string | null
): {
  serve: (params: unknown) => Promise<BridgeChatForkResult>
  sheet: React.JSX.Element | null
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const open = useRef<Pending | null>(null)
  const running = useRef(false)
  const ctx = useRpcClientContext()
  const { client } = useHostClient(hostId)
  const openMobileSession = useOpenMobileSession()
  const finish = useCallback((result: BridgeChatForkResult) => {
    const current = open.current
    open.current = null
    current?.settle(result)
    setPending((shown) => (shown ? { ...shown, visible: false } : null))
  }, [])
  // A new page document, or leaving the screen, cancels what the old one asked for.
  useEffect(() => () => finish({ outcome: 'cancelled' }), [finish, sessionId])
  const serve = useCallback((params: unknown): Promise<BridgeChatForkResult> => {
    const read = chatForkParamsSchema.parse(params)
    if (open.current || running.current) {
      return Promise.reject(new Error('a Fork sheet is already open'))
    }
    return new Promise((settle) => {
      const entry: Pending = { params: read, settle, visible: true }
      open.current = entry
      setPending(entry)
    })
  }, [])
  const acquireHost = useCallback<ChatForkRunDeps['acquireHost']>(
    (targetHostId) => {
      const acquisition = {}
      const held = ctx.acquire(targetHostId, acquisition)
      return { client: held, release: () => ctx.release(targetHostId, acquisition) }
    },
    [ctx]
  )
  const confirm = useCallback(
    (target: ChatForkRunTarget) => {
      const params = open.current?.params
      if (!params || running.current) {
        return
      }
      if (target.hostId === hostId) {
        finish({ outcome: 'here', target: wireTarget(target) })
        return
      }
      running.current = true
      setBusy(true)
      void runOnOtherHost(params, target, {
        client,
        hostId,
        acquireHost,
        openSession: (targetHostId, worktreeId, name) =>
          openMobileSession({ hostId: targetHostId, worktreeId, name }),
        onProgress: setProgress
      }).then((notices) => {
        running.current = false
        setBusy(false)
        setProgress(null)
        finish({ outcome: 'done', notices })
      })
    },
    [acquireHost, client, finish, hostId, openMobileSession]
  )
  if (!pending) {
    return { serve, sheet: null }
  }
  const { params } = pending
  return {
    serve,
    sheet: (
      <MobileChatForkSheet
        key={`${params.forkFrom.sessionId}:${params.forkFrom.throughItemId}`}
        visible={pending.visible}
        preset={params.preset}
        source={{
          hostId,
          worktreeId: params.worktreeId,
          client,
          capabilities: params.capabilities,
          agent: params.agent,
          surface: params.surface,
          usageLimited: params.usageLimited,
          canCopy: params.canCopy,
          canExport: params.canExport,
          canNewWorktree: params.canNewWorktree,
          canSubagent: params.canSubagent
        }}
        busy={busy}
        progress={progress}
        onConfirm={confirm}
        onClose={() => {
          if (!running.current) {
            finish({ outcome: 'cancelled' })
          }
        }}
        onAfterClose={() => setPending((shown) => (shown?.visible ? shown : null))}
      />
    )
  }
}

/** Forks onto another paired host from here, holding both connections; returns what to tell the page. */
async function runOnOtherHost(
  params: BridgeChatForkParams,
  target: ChatForkRunTarget,
  deps: Pick<ChatForkRunDeps, 'acquireHost' | 'openSession' | 'onProgress'> & {
    client: RpcClient | null
    hostId: string
  }
): Promise<string[]> {
  const notices: string[] = []
  const say = (message: string): void => {
    if (notices.length < MAX_NOTICES) {
      notices.push(message.slice(0, MAX_NOTICE_CHARS))
    }
  }
  try {
    await runChatFork(
      {
        client: deps.client,
        hostId: deps.hostId,
        worktreeId: params.worktreeId,
        agent: params.agent,
        terminal: params.surface === 'terminal',
        recap: (scope) => params.recaps[scope]
      },
      {
        createFork: pageOnly,
        createWorktreeFork: pageOnly,
        acquireHost: deps.acquireHost,
        openSession: deps.openSession,
        onProgress: deps.onProgress,
        showToast: say
      },
      target,
      params.forkFrom
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim() : ''
    say(chatForkCopy.failed(TUI_AGENT_DISPLAY_NAMES[target.agent], detail))
  }
  return notices.filter((notice) => notice.length > 0)
}

function wireTarget(
  target: ChatForkRunTarget
): Extract<BridgeChatForkResult, { outcome: 'here' }>['target'] {
  const { hostCapabilities, ...rest } = target
  return hostCapabilities ? { ...rest, hostCapabilities: [...hostCapabilities] } : rest
}

/** A shell page's device verbs, with the app's Fork sheet serving its own. */
export function useShellDeviceVerbs(hostId: string, sessionId: string | null) {
  const chatFork = useShellChatForkSheet(hostId, sessionId)
  const serveDevice = useNativeDeviceVerbs(sessionId)
  const serve = (verb: NativeDeviceVerb | typeof BRIDGE_CHAT_FORK_VERB, params: unknown) =>
    verb === BRIDGE_CHAT_FORK_VERB ? chatFork.serve(params) : serveDevice(verb, params)
  return { serve, sheet: chatFork.sheet }
}
