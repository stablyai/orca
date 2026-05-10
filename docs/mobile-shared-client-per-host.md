# Single Shared RPC Client per Host (Mobile)

Design doc for collapsing the per-screen WebSocket connection model into a
single shared `RpcClient` per paired host, owned by a React context that
sits above the route tree.

## Problem

The mobile app today opens **one WebSocket per screen per host**:

| Screen | Connections per host |
|---|---|
| Home (`app/index.tsx`) | 1 (with persistent `accounts.subscribe` stream) |
| Host detail (`app/h/[hostId]/index.tsx`) | +1 |
| Worktree session (`app/h/[hostId]/session/[worktreeId].tsx`) | +1 |
| Accounts (`app/h/[hostId]/accounts.tsx`) | +1 |
| Pair confirm (briefly) | +1 |

A user actively browsing one host typically holds **3–4 simultaneous
sockets** to the desktop runtime. Each call to `connect()` runs its own
E2EE handshake, allocates an ephemeral keypair, and runs an independent
reconnect loop with exponential backoff.

This causes three observable problems:

1. **Stuck-connecting / reconnecting for minutes.** The desktop's
   `MAX_WS_CONNECTIONS = 32` is shared across all clients. A user who
   navigates rapidly accumulates stale sockets faster than they can be
   reaped by TCP keepalive (which can take 60–300s on default systems
   for half-open connections from a phone leaving Wi-Fi range or
   backgrounding). Once the cap is hit, new sockets are rejected with WS
   close code `1013 Maximum connections reached`. The mobile reconnect
   loop does not recognize 1013 as terminal — it retries with backoff,
   each retry also dropped, until enough stale sockets are reaped.
   Result: a screen that should connect in <1s is stuck for 1–5 minutes.
2. **Tab create/delete hangs.** `client.sendRequest('terminal.create')`
   awaits `waitForConnected()`. If the session-screen client is in
   `connecting`/`reconnecting` state because its socket lost the cap
   race, the await blocks until the 30s `REQUEST_TIMEOUT_MS` fires.
   The user sees nothing happen.
3. **Triple cost on every cold-start.** Three E2EE handshakes,
   three Curve25519 keypair generations, three subscription
   re-registrations on every app launch. On low-end Android, this
   visibly delays first paint by hundreds of milliseconds.

The architecture also wastes server resources: each socket carries its
own E2EE channel, its own subscription set, its own driver-state-machine
client identity (cf. `docs/mobile-presence-lock.md`). The server already
has logic to reconcile multi-socket-per-token tear-down
(`hasOtherConnections` in `ws-transport.ts`) — that logic exists *because*
this design forced the question; with a single client per host, it becomes
unnecessary.

## Today's transport ownership

Five files independently call `connect(endpoint, deviceToken, publicKeyB64)`:

```
mobile/app/pair-confirm.tsx       # one-shot during pairing
mobile/app/pair-scan.tsx          # one-shot during pairing
mobile/app/index.tsx              # N (one per paired host)
mobile/app/h/[hostId]/index.tsx   # 1 (host detail)
mobile/app/h/[hostId]/session/[worktreeId].tsx  # 1 (session)
mobile/app/h/[hostId]/accounts.tsx              # 1 (accounts)
```

Each owns a `useRef<RpcClient | null>` and calls `client.close()` from a
cleanup function. The home screen additionally maintains a
`clientsRef: Array<{ hostId, client }>` so its own usage of the per-host
client survives across navigation events.

This pattern works for *correctness* — every cleanup eventually closes
its socket — but it breaks under three real-world conditions:

1. **Rapid navigation.** Mounts spawn before unmounts complete; cleanup
   `client.close()` runs after a new screen has already opened a fresh
   socket to the same host. Two sockets briefly coexist for the same
   token, multiplied across screens.
2. **Network drops.** A backgrounded/locked phone on a flaky network
   leaves sockets half-open. The server doesn't get a FIN; cleanup
   relies on TCP keepalive timing. Meanwhile the foreground app, on
   resume, opens fresh sockets. The half-open ones eat the cap until
   reaped.
3. **Hot reload during dev.** Each Metro hot reload fires a new render
   tree without unmounting the old, so connections leak.

## Goal

> A paired host has at most **one active WebSocket** at any time, owned
> by a context provider above the route tree. All screens for that host
> share that client. The pair flows are the only places that create
> short-lived clients (and they explicitly close those after pairing
> completes).

This is the architectural fix to the symptoms above. Combined with the
two recently-shipped hotfixes (token cache + stable `useEffect`
dependency on home screen), this completes the connection-lifecycle
work.

## Design

### Layered ownership

```
RootLayout (<RpcClientProvider>)
└── routes
    └── <HostScopedClientGate hostId={...}>   // mounts when route has hostId
        ├── h/[hostId]/                       // host detail
        ├── h/[hostId]/session/[worktreeId]/  // session
        └── h/[hostId]/accounts/              // accounts
```

Two providers, layered:

1. **`RpcClientProvider` (root)** — owns one `RpcClient` per host,
   keyed by `hostId`. Lifecycle: opens on first request for that
   host's client, holds open until app shutdown OR until the host is
   removed (`removeHost(hostId)` triggers explicit close). Reuses
   existing `loadHosts()` cache from the recently-merged
   `host-store.ts` work.
2. **`HostScopedClientGate` (per host)** — a thin route-layout
   component placed at `app/h/_layout.tsx`. Reads `hostId` from
   route params, requests the client for that host from the root
   provider, exposes it via context to descendants, and renders a
   loading state until the client reaches `connected`. Guarantees
   every descendant screen sees the same client instance for that
   host — no per-screen `connect()` calls.

The home screen (`app/index.tsx`) lives outside `HostScopedClientGate`
since it spans all hosts; it consumes the root provider directly via
a multi-host hook (see API below).

### API

```ts
// New file: mobile/src/transport/client-context.tsx
type RpcClientContext = {
  // Get-or-open. Returns the singleton client for hostId; opens it
  // lazily on first call, reuses it for all subsequent callers. Never
  // returns null (returns a placeholder client in 'connecting' state
  // if open hasn't completed).
  getClient: (hostId: string) => RpcClient
  // Connection state for a given host (driven by client.onStateChange).
  useHostState: (hostId: string) => ConnectionState
  // Useful for the home screen which renders all hosts at once.
  useAllClients: () => Array<{ hostId: string; client: RpcClient }>
}

export const RpcClientProvider: React.FC<{ children: React.ReactNode }>

export const useHostClient: (hostId: string) => {
  client: RpcClient
  state: ConnectionState
}
```

Internal store (single `useRef` in the provider):

```ts
type StoreEntry = {
  client: RpcClient
  state: ConnectionState
  refCount: number       // number of active screens holding this client
  closeTimer: NodeJS.Timeout | null
}
const store = useRef(new Map<string, StoreEntry>())
```

### Lifecycle rules

1. **Open on first read.** First `getClient(hostId)` call for a host
   reads the host record (uses cached `loadHosts()`), then calls
   `connect()` and stores the client. Subsequent calls return the
   cached entry.
2. **Idle close timer.** When `refCount` drops to 0 (all screens for
   that host unmounted), schedule a 30-second close timer. If a screen
   for the same host mounts within 30s, cancel the timer. Otherwise,
   close the client and remove from the store.
   - Why 30s: covers fast tab-switching and back-navigation without
     keeping idle sockets forever. Tunable based on observed behavior.
3. **Forced close on host removal.** `removeHost(hostId)` from
   `host-store.ts` calls into the provider to close the client
   immediately and delete the store entry.
4. **App backgrounded.** No special action — let TCP keepalive and
   server-side reaping handle it. Reconnect happens on foreground.
5. **App foregrounded.** Trigger a `getState()` poll on every
   non-closed entry; if any are in `disconnected` (TCP died while
   backgrounded), the existing reconnect loop handles it. No new
   client allocations.

### Public surface for screens

Each screen replaces:

```ts
// Before
const [client, setClient] = useState<RpcClient | null>(null)
const [connState, setConnState] = useState<ConnectionState>('disconnected')

useEffect(() => {
  let rpcClient: RpcClient | null = null
  void (async () => {
    const hosts = await loadHosts()
    const host = hosts.find((h) => h.id === hostId)
    if (!host) return
    rpcClient = connect(host.endpoint, host.deviceToken, host.publicKeyB64, setConnState)
    setClient(rpcClient)
  })()
  return () => {
    rpcClient?.close()
  }
}, [hostId])
```

with:

```ts
// After
const { client, state } = useHostClient(hostId)
```

Total LoC reduction across screens: ~150 lines.

### Pair flow exception

`app/pair-confirm.tsx` and `app/pair-scan.tsx` continue to call `connect()`
directly with **explicit `client.close()`** after the test request returns.
Reason: the host record doesn't yet exist in `loadHosts()` during pairing,
so the provider has nothing to look up. The pair flow's client is a
short-lived transient that delivers `getStatus()` once and then dies.

After `saveHost()` succeeds, the user is navigated away; the next time
they enter `/h/[hostId]/...`, the provider opens a fresh client through
the normal path.

### Streaming subscription handling

The home screen's `accounts.subscribe` stream and the session screen's
terminal subscriptions remain owned by their respective screens — the
provider doesn't manage subscriptions, only the underlying transport.
Each screen's effect calls `client.subscribe(...)` and stores the
returned unsubscribe function. On unmount, the screen unsubscribes
(returns to the existing per-screen pattern, just over a shared
transport). The transport's `subscribe()` already correctly multiplexes
multiple listeners on one WebSocket via the `id` field.

### State propagation

`useHostState(hostId)` returns the live `ConnectionState`. The provider
maintains a per-host `useState` keyed by hostId; the `client.onStateChange`
listener is wired once at client creation and updates the corresponding
state slot. `useHostState` reads from this state via `useSyncExternalStore`
or a context selector — the choice is mostly preference; in this
codebase, given the small state shape, a simple `useContext + useMemo`
of the matching slot is fine.

## Migration

Step-by-step, each step independently shippable:

1. **Add `RpcClientProvider` and `useHostClient`.** No callers yet.
   Wire into `app/_layout.tsx`. Existing screens unchanged.
2. **Migrate session screen** (highest-risk, most-used). Replace
   per-screen `connect()` with `useHostClient`. Test connection
   behavior, terminal create/delete, scrollback hydration.
3. **Migrate host detail and accounts screens.** Same pattern.
4. **Migrate home screen.** Replace `clientsRef` with
   `useAllClients()`. The home screen's per-host streaming
   subscriptions move into a hook that runs per-host.
5. **Add `HostScopedClientGate`** at `app/h/_layout.tsx` to centralize
   the gate and remove duplicated loading-state logic.
6. **Delete legacy code.** Remove the dead `connect()` import paths
   from each screen. Codepoint reduction.
7. **Remove server-side `hasOtherConnections` complexity** in a
   follow-up: with one socket per token, the multi-socket reconciliation
   in `runtime-rpc.ts` `wsTransport.onConnectionClose` simplifies.
   This is a desktop-side cleanup PR done after mobile rolls out.

Each step is tested in isolation; rollback per step is trivial.

## Risks

### R1: Connection loss while screens are mounted

**Risk.** Today, when a screen unmounts due to network loss, its
client closes and reopens on remount. Under the new design, a
network-loss-during-screen-mounted means the client lives but is in
`reconnecting` state.

**Mitigation.** The existing `RpcClient` already handles this — its
internal reconnect loop runs invisibly. Screens already render based
on `connState === 'connected'`, so they stay in their `connecting`
UI until the loop succeeds. No regression.

### R2: One bad host poisons the singleton

**Risk.** If the client for one host is wedged in `reconnecting` due
to a desktop-side issue, all screens for that host inherit the wedged
state. Under the per-screen design, navigating to a different screen
gave a fresh client with a chance to connect cleanly.

**Mitigation.** "Force reconnect" affordance: a button on the host
detail "Connection issues" UI calls
`provider.forceReconnect(hostId)` — close + reopen the client. Users
who hit a stuck state get a one-tap recovery without uninstalling.
Implemented as part of step 2.

### R3: Idle close timer races

**Risk.** A user navigates from session → home → back to session
within 35 seconds. The 30s idle timer fires between hops and closes
the client; the back-navigation has to wait for a fresh handshake.

**Mitigation.** Cancel the timer at `getClient(hostId)` time, not at
mount time. As long as the consumer holds a reference to the client,
the timer is paused. Standard refcount pattern.

### R4: Memory / state leak on rapid host removal

**Risk.** User removes a host while a screen for it is mounted.
The screen's reference is now dangling.

**Mitigation.** `removeHost(hostId)` triggers an explicit close +
delete from the store. Screens already handle `auth-failed` /
`disconnected` states (the client transitions to one of them on
forced close). Add a navigation-bounce in those states so the screen
returns to the host list.

### R5: Pair-flow socket leaks through provider

**Risk.** If pair-confirm crashes mid-handshake before its explicit
`close()`, the socket leaks.

**Mitigation.** Independent of the provider — same risk exists today.
Add a try/finally + cleanup useEffect in pair-confirm.

### R6: Provider re-initialization on hot reload (dev only)

**Risk.** Metro hot reload re-runs `RpcClientProvider`, possibly
spawning new clients while old ones are still in the store.

**Mitigation.** On provider mount, scan the store for entries whose
clients report `closed` state and prune. Acceptable dev-only friction.

## Test Plan

### Unit / hook tests

- `useHostClient` returns the same client instance across multiple
  consumers for the same hostId.
- `removeHost(hostId)` immediately closes the client (assert via
  `client.getState()`).
- Idle close timer: zero refcount → 30s wait → client closed.
- Idle close timer cancellation: zero refcount → 15s wait →
  consumer subscribes → no close.

### Integration / manual

- Create one host; navigate home → host detail → session → back ×10
  rapidly. Single socket on desktop (verify via desktop debug log).
- Background app for 5 min; foreground; verify reconnect uses same
  client instance, no leak.
- Remove host while session screen mounted; screen bounces back to
  home; client closed.
- Force-reconnect button on host detail; client closes and reopens
  cleanly.
- Hot reload during development; no socket leak (verify desktop
  active-connection count).

### Regression

- Terminal create/delete works during normal browse (Bug A from
  initial reports — should never recur once cap pressure is removed).
- Scrollback hydration unchanged.
- Phone-fit / driver-lock state machine unchanged
  (`docs/mobile-presence-lock.md` invariants hold).

## Out of scope

- **Desktop-side connection LRU eviction.** Useful as a defense-in-depth
  but not needed once mobile self-limits to one socket per host.
- **Application-level ping/pong.** Worth adding but separate concern;
  helps server reap dead sockets faster regardless of how many a single
  client opens.
- **iOS share extension or system-wide deep-link integration.** Future
  product work.

## Effort estimate

3–4 hours including tests and incremental migration. Each step
independently mergeable.

## References

- `docs/mobile-presence-lock.md` — driver-state-machine that depends
  on per-client identity. Single-client-per-host simplifies but
  doesn't break this contract.
- `docs/mobile-prefer-renderer-scrollback.md` — scrollback hydration
  flow. Subscriptions remain per-screen; transport changes are
  transparent.
- `mobile/src/transport/rpc-client.ts` — existing `connect()`
  implementation; reconnect loop, E2EE handshake, subscription
  multiplexing all preserved as-is.
- `src/main/runtime/rpc/ws-transport.ts` — server-side
  `MAX_WS_CONNECTIONS = 32`, `hasOtherConnections` reconciliation
  that becomes simpler post-migration.
