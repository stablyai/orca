import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { subscribeRuntimeClientEvents } from '../transport/runtime-client-event-subscription'
import {
  HOST_REFRESH_FALLBACK_MS,
  type HostAppState
} from '../worktree/execution-hosts/host-worktree-refresh'
import {
  botChangeConcerns,
  readBotChangeScope,
  type BotChangeInterest,
  type BotChangeScope
} from '../../../src/shared/bots/bot-change-scope'

/** Re-reads a bot view the way the host list re-reads workspaces: on the host's botsChanged, after a
 *  reconnect and on the foreground, never in the background. A stream not up yet, or a read that
 *  failed, falls back to the host list's poll. */
export function startHostBotRefresh({
  client,
  appState,
  refresh,
  listed,
  interest
}: {
  client: Pick<RpcClient, 'subscribe'>
  appState: HostAppState
  /** Gets the notice's scope; none for a reconnect, the foreground or an older host's notice. */
  refresh: (changed?: BotChangeScope) => void
  /** Read per tick: whether the last read listed the host's bots. */
  listed: () => boolean
  /** Read per notice: the bot and kinds of change the view shows; without it, every notice reads. A
   *  notice from an older host names none, and reads. */
  interest?: () => BotChangeInterest
}): () => void {
  let streamReady = false
  const refreshInForeground = (changed?: BotChangeScope): void => {
    if (appState.currentState === 'active') {
      refresh(changed)
    }
  }
  const appStateSubscription = appState.addEventListener('change', (state) => {
    if (state === 'active') {
      refresh()
    }
  })
  const interval = setInterval(() => {
    if (!listed() || !streamReady) {
      refreshInForeground()
    }
  }, HOST_REFRESH_FALLBACK_MS)
  const unsubscribe = subscribeRuntimeClientEvents(client, {
    onReady: (replayed) => {
      streamReady = true
      if (replayed) {
        refreshInForeground()
      }
    },
    onLost: () => {
      streamReady = false
    },
    onEvent: (event) => {
      if (event.type !== 'botsChanged') {
        return
      }
      const changed = readBotChangeScope(event)
      if (!interest || botChangeConcerns(changed, interest())) {
        refreshInForeground(changed)
      }
    }
  })
  refresh()
  let stopped = false
  return () => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(interval)
    appStateSubscription.remove()
    unsubscribe()
  }
}
