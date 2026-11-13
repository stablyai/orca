import type { OrcaMobileWebShellViewHandle } from '../../modules/orca-mobile-web-shell/src'
import { buildNativeChatVisualDocument } from '../../../src/shared/native-chat/native-chat-visual-shell'
import { visualDocumentParamsSchema } from '../mobile-web-shell/bridge/bridge-visual-verbs'
import { readMobileNativeChatVisual } from '../session/native-chat/visual/mobile-native-chat-visual-read'
import { MOBILE_NATIVE_CHAT_VISUAL_THEME } from '../session/native-chat/visual/mobile-native-chat-visual-theme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { scopeRpcClientToExecutionHost } from '../worktree/execution-host-scoped-rpc-client'
import { randomV4Uuid } from './random-v4-uuid'

export function createNativeVisualDocumentServer(deps: {
  readClient: () => RpcClient | null
  readView: () => OrcaMobileWebShellViewHandle | null
}) {
  let alive = true
  const issued = new Map<string, OrcaMobileWebShellViewHandle>()
  return {
    serve: async (params: unknown) => {
      const request = visualDocumentParamsSchema.parse(params)
      if (request.action === 'release') {
        const owner = issued.get(request.url)
        issued.delete(request.url)
        await owner?.releaseVisualDocument(request.url)
        return { kind: 'released' }
      }
      const client = deps.readClient()
      const view = deps.readView()
      if (!alive || !client || !view) {
        throw new Error('The visual page is no longer mounted')
      }
      const reading = await readMobileNativeChatVisual(
        {
          client: request.executionHost
            ? scopeRpcClientToExecutionHost(client, request.executionHost)
            : client,
          sessionId: request.sessionId
        },
        request.file
      )
      if (
        !alive ||
        deps.readView() !== view ||
        deps.readClient() !== client ||
        reading.kind !== 'ready'
      ) {
        throw new Error('The visual document is unavailable')
      }
      const channel = randomV4Uuid()
      const url = await view.createVisualDocument(
        buildNativeChatVisualDocument({
          html: reading.html,
          channel,
          theme: MOBILE_NATIVE_CHAT_VISUAL_THEME,
          base: 'document'
        })
      )
      if (!alive || deps.readView() !== view || deps.readClient() !== client) {
        await view.releaseVisualDocument(url)
        throw new Error('The visual page changed while loading')
      }
      issued.set(url, view)
      return { kind: 'ready', url, channel }
    },
    dispose: () => {
      alive = false
      for (const [url, view] of issued) {
        void view.releaseVisualDocument(url).catch(() => {})
      }
      issued.clear()
    }
  }
}
