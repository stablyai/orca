import { DirectRpcClient } from '../transport/direct-rpc-client'
import { decodePairingUrl } from '../transport/pairing'
import {
  fileOwnershipRuntimeStatusRead,
  fileOwnershipWorktreeRead
} from '../files/mobile-file-ownership-operations'
import { createBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { useMobileSessionContentCreateActions } from '../session/use-mobile-session-content-create-actions'
import { mountFixture } from './rpc-recording/recorder-fixture-shape'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

export async function createPairedMarkdownNote(
  pairingUrl: string,
  worktreeId: string,
  transport: 'native-direct' | 'web-bridge'
) {
  const offer = decodePairingUrl(pairingUrl)
  if (!offer) {
    throw new Error('The isolated host returned an unreadable pairing offer')
  }
  const direct = new DirectRpcClient(offer.endpoint, offer.deviceToken, offer.publicKeyB64, {})
  let bridge: ReturnType<typeof createBridgePortPair> | undefined
  let screen: Root | undefined
  const timers: ReturnType<typeof setTimeout>[] = []
  try {
    const statusReply = await fileOwnershipRuntimeStatusRead.request(direct, undefined, {
      timeoutMs: 15_000
    })
    if (transport === 'web-bridge') {
      bridge = createBridgePortPair({ rpc: direct, clientIdentity: offer.pairedDeviceId ?? null })
      await bridge.flush()
    }
    let creatingMarkdown = false
    let error = ''
    const scope = mountFixture<Parameters<typeof useMobileSessionContentCreateActions>[0]>({
      client: bridge?.client ?? direct,
      worktreeId,
      creatingMarkdown,
      setCreatingMarkdown: (value) => {
        creatingMarkdown = typeof value === 'function' ? value(creatingMarkdown) : value
      },
      setCreateError: (value) => {
        error = typeof value === 'function' ? value(error) : value
      },
      handleCreateBrowserRef: { current: async () => false },
      scheduleDelayedAction: (callback, delayMs) => timers.push(setTimeout(callback, delayMs)),
      fetchSessionTabs: async () => {},
      showToast: () => {}
    })
    const observed: { actions?: ReturnType<typeof useMobileSessionContentCreateActions> } = {}
    function Harness(): null {
      observed.actions = useMobileSessionContentCreateActions(scope)
      return null
    }
    screen = createRoot(document.createElement('div'))
    flushSync(() => screen?.render(createElement(Harness)))
    const actions = observed.actions
    if (!actions) {
      throw new Error('The note-creation hook did not mount')
    }
    await actions.handleCreateMarkdownNote()
    const worktreeReply = await fileOwnershipWorktreeRead.request(
      bridge?.client ?? direct,
      { worktree: `id:${worktreeId}` },
      { timeoutMs: 15_000 }
    )
    const replies = bridge?.readToPage() ?? []
    return {
      creatingMarkdown,
      error,
      hostReads: [statusReply, worktreeReply].map((reply) => ({
        ok: reply.ok,
        runtimeId: reply._meta?.runtimeId
      })),
      calls: (bridge?.readToShell() ?? []).flatMap((frame) => {
        if (frame.type !== 'request') {
          return []
        }
        const reply = replies.find(
          (candidate) => candidate.type === 'reply' && candidate.id === frame.id
        )
        if (!reply || reply.type !== 'reply' || !('payload' in reply)) {
          return []
        }
        return [
          {
            method: frame.method,
            params: frame.params,
            options: frame.options,
            ok: reply.payload.ok,
            runtimeId: reply.payload._meta?.runtimeId
          }
        ]
      }),
      bridgedMethods: bridge
        ?.readToShell()
        .flatMap((frame) => (frame.type === 'request' ? [frame.method] : []))
    }
  } finally {
    for (const timer of timers) {
      clearTimeout(timer)
    }
    screen?.unmount()
    bridge?.client.close()
    bridge?.host.dispose()
    direct.close()
  }
}
