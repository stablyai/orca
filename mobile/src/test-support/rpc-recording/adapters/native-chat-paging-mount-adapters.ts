import { hookScreenMount } from '../mounted-screen-tree'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const SOURCE_IDENTITY = 'host-1::repo-1::/work/feature'
const AGENT = 'claude'
const SESSION = 'session-1'
const TRANSCRIPT_PATH = '/work/feature/.claude/session-1.jsonl'

// Use real subscribe frames to arm paging capability/cursor state; observe message ids because window membership, not text, is the claim.
export function nativeChatPagingMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.native-chat-page': ({ client, effect }) => {
      const useMobileNativeChatSession = modules.load<
        typeof import('../../../session/use-mobile-native-chat-session')
      >('mobile/src/session/use-mobile-native-chat-session.ts').useMobileNativeChatSession
      let value: ReturnType<typeof useMobileNativeChatSession> | undefined
      const screen = hookScreenMount(() => {
        value = useMobileNativeChatSession({
          client,
          sourceIdentity: SOURCE_IDENTITY,
          agent: AGENT,
          sessionId: SESSION,
          transcriptPath: TRANSCRIPT_PATH
        })
      }, effect)
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return screen.mount()
          }
          if (name === 'load-earlier') {
            value?.loadEarlier()
            return screen.update()
          }
          if (name === 'unmount') {
            return screen.unmount()
          }
          throw new Error(`Unknown native chat paging action: ${name}`)
        },
        state: () => ({
          messageIds: value?.messages.map((message) => message.id) ?? null,
          status: value?.status ?? null,
          transcriptLoading: value?.transcriptLoading ?? null,
          hasMore: value?.hasMore ?? null,
          loadingEarlier: value?.loadingEarlier ?? null,
          error: value?.error ?? null,
          crash: screen.crash()
        }),
        dispose: screen.unmount
      }
    }
  }
}
