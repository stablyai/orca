/**
 * Every product call site that opens a host stream, and what the recording oracle can see of it.
 *
 * The raw-request-port inventory next door counts down to zero; this one does not. A subscribe is
 * not something a typed operation replaces — `RpcOperation` fixes a method, an acceptance policy
 * and a reader for one reply, and a stream has many. What this list is for is the other half of
 * the same question: which of these streams is a golden actually holding, and for the ones it is
 * not, what exactly stops it. Left as prose in a README that answer went stale twice, because
 * nothing failed when a new `client.subscribe` appeared.
 *
 * So each site is classified, and `rpc-subscription-boundary.test.ts` makes the classification
 * bind: a new site with no entry fails, an entry whose file no longer subscribes fails, an entry
 * naming the wrong method fails, and a `recorded` entry whose family is not in the scenario
 * manifest fails. A wall must name itself; "not recorded yet" and "cannot be recorded" are
 * different claims and only one of them is a backlog item.
 */
export type RpcSubscriptionCoverage =
  /** A golden holds this stream. `family` is a family in `pilot-scenarios.json`. */
  | { readonly kind: 'recorded'; readonly family: string }
  /** The recorder could mount this site; nobody has written the scenario. A backlog item. */
  | { readonly kind: 'unwritten-scenario' }
  /** Something structural stops a recording. Not a backlog item until the wall moves. */
  | { readonly kind: 'walled'; readonly wall: string }

export type RpcSubscriptionSite = {
  readonly file: string
  readonly method: string
  readonly coverage: RpcSubscriptionCoverage
}

export const RPC_SUBSCRIPTION_SITES: readonly RpcSubscriptionSite[] = [
  // The account snapshot, opened twice. The home screen wires one per connected host; the host
  // screen opens its own. Both decode the same snapshot, and neither is the wall — the loader
  // reaches `decodeAccountsSnapshot` and it throws its own domain error on a bad one.
  {
    file: 'app/h/[hostId]/accounts.tsx',
    method: 'accounts.subscribe',
    coverage: {
      kind: 'walled',
      wall: 'The screen reads `expo-router.useFocusEffect` and `react-native.ScrollView`, neither a substituted member, so the mount trap refuses before any effect runs. The engine gains `useFocusEffect` on its own track.'
    }
  },
  {
    file: 'src/home/use-mobile-home-host-connections.ts',
    method: 'accounts.subscribe',
    coverage: {
      kind: 'walled',
      wall: 'Wired on a per-host client from `useAllHostClients`, and the runner hands an adapter one client rather than the multi-host context that hook reads.'
    }
  },
  // The browser tab's screencast. Frames are pixels, not JSON.
  {
    file: 'src/browser/use-mobile-browser-stream.ts',
    method: 'browser.screencast',
    coverage: {
      kind: 'walled',
      wall: 'Writes to a webview terminal/browser ref this runner has no substitute for, and a substitute that shaped what the stream delivered would be inventing the device.'
    }
  },
  {
    file: 'src/notifications/mobile-notifications.ts',
    method: 'notifications.subscribe',
    coverage: { kind: 'recorded', family: 'notifications.desktop-stream' }
  },
  {
    file: 'src/session/mobile-terminal-stream-subscribe.ts',
    method: 'terminal.subscribe',
    coverage: {
      kind: 'walled',
      wall: 'Writes to a webview terminal ref this runner has no substitute for: the stream consumer calls `ref.init` and `dataRef.write`, so what a frame does is a device effect rather than an observation.'
    }
  },
  {
    file: 'src/session/use-live-worktree-name.ts',
    method: 'runtime.clientEvents.subscribe',
    coverage: { kind: 'recorded', family: 'live-worktree-name' }
  },
  {
    file: 'src/session/use-mobile-native-chat-session.ts',
    method: 'nativeChat.subscribe',
    coverage: { kind: 'recorded', family: 'session.native-chat-page' }
  },
  // The structured agent session's event stream. Mountable: its listener guards the payload, and
  // the hold that precedes it is a plain request. What is missing is the scenario.
  {
    file: 'src/session/use-mobile-structured-agent-state.ts',
    method: 'agentSession.subscribe',
    coverage: { kind: 'unwritten-scenario' }
  },
  // The session tab snapshot. Mountable behind the reconciliation controller the hook already
  // takes; no device surface is involved.
  {
    file: 'src/session/use-mobile-session-tabs-reconciliation.ts',
    method: 'session.tabs.subscribe',
    coverage: { kind: 'unwritten-scenario' }
  },
  {
    file: 'src/worktree/host-worktree-refresh.ts',
    method: 'runtime.clientEvents.subscribe',
    coverage: { kind: 'recorded', family: 'host-worktree-refresh' }
  }
]
