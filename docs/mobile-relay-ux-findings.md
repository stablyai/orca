# Mobile Relay UX — Investigation Findings & Fix Plan

Scope: phone-side presentation/state-machine issues behind three reported symptoms on Android over
the cloud relay. The relay protocol and server-side assignment are healthy; nothing here changes
desktop or relay-server code. All file references are in `mobile/` of this worktree.

## 1. Symptom → root-cause summary

| # | Symptom | Root cause (verified) |
|---|---------|----------------------|
| S1 | Resume lands on an empty "Host" page, grey dot | Bare cross-stack `router.push` into a cold nested host navigator resolves to the host index route **without the `hostId` param**; every screen below then runs with `hostId: undefined` |
| S2 | Tapping a healthy relay host shows grey 1–2s before green | Every screen focus funnels into the network-handoff recovery path, which **suspends the healthy relay session** (publishes `disconnected`) and re-dials; the re-dial is invisible because `migrateTo` binds new-session state only after authentication |
| S3 | Relay-forced pairing looks dead ~5–10s | The pairing relay path has **no log sink** (only direct-path entries reach the "Pairing log"), and post-pairing the app dials the unreachable LAN endpoint for up to 12s before relay recovery is even eligible |

## 2. Verified end-to-end causal chains

### S1 — Resume dead-ends on the host index page

1. Home renders the Resume card only once `hostStates[lastVisited.hostId] === 'connected'`
   (`app/index.tsx:488`); over relay that is seconds after the host list paints, and the card
   inserts **above** the Tasks card in the same footer (`app/index.tsx:733-780`) — a layout shift
   under the thumb.
2. Tap → bare `router.push(createMobileSessionHref(...))` (`app/index.tsx:740-746`) targeting
   `/h/[hostId]/session/[worktreeId]`.
3. With the `h` group cold (cold start, or host never visited this session), Expo Router resolves
   the push to the host stack's **index route with no `hostId` param**. This exact failure mode is
   documented twice in-repo ("cold Expo deep links resolve to index" —
   `src/transport/host-edit-navigation.ts:52`, `src/tasks/mobile-task-navigation.ts:90`) and is the
   root cause named by PR #12001.
4. `app/h/_layout.tsx:64` reads `hostId` via `useGlobalSearchParams` → `undefined`.
   `HostProtocolGate` gets `hostId: undefined`; `useHostClient(undefined)` returns
   `state: 'disconnected'` (`src/transport/client-context.tsx:344`) → **grey dot**.
5. The host index screen renders the fallback title `'Host'` (`app/h/[hostId]/index.tsx:821`), and
   every fetch no-ops on `!client || connState !== 'connected'`
   (`app/h/[hostId]/index.tsx:298,364,418,520`) → **empty list**. The Filter/Recent/Repo chips are
   static toolbar UI, so the page looks "real" but dead.
6. "Sometimes": a warm host stack resolves the same push correctly, so the bug is intermittent by
   navigation history.

Corrections to the preliminary sweep: the empty page is primarily the missing `hostId` param, not
the connection-gated fetches or the cold 30s worktree cache (those matter only when landing *with*
a valid `hostId`, e.g. the mistap-strand case). Also, the Resume target "validation" is weaker than
it looks: `getCachedWorktrees` is seeded from the persisted home snapshot at hydration
(`app/index.tsx:264-277`) and the 30s TTL is stamped at seed time (`src/cache/worktree-cache.ts:20`),
so a worktree deleted while the phone was off still passes until a live `worktree.ps` overwrites it.

**Fix**: PR #12001 ("open the Resume workspace through a mounted host stack") routes Resume through
the same mount-then-replace mechanism Tasks uses, extracted to `src/navigation/host-stack-navigation.ts`.
Reviewed and validated per Jinwoo; **merged to main as `7948e46db855`** after final validation
(see §4, F0). Residual S1 items it does not cover: bare notification/accounts/deep-link pushes (F4),
catalog validation + not-found bounce (F7), Resume-card layout shift (F8), gate unmount hazard (F9).

### S2 — grey blink when focusing a healthy relay host

1. Every focus of the host screen fires `notifyForeground()`
   (`app/h/[hostId]/index.tsx:512-517`, deliberately empty deps).
2. `openHostLogicalClient` wraps that into `endpointLifecycle.setForeground(true)`
   (`src/transport/host-logical-client.ts:31-33`); the lifecycle forwards without dedupe
   (`src/transport/mobile-endpoint-lifecycle.ts:62-64`).
3. `MobileEndpointSupervisor.setForeground(true)` computes `wasForeground = true` and calls
   `RelayReconnectController.handleForeground` (`src/transport/mobile-endpoint-supervisor.ts:115-119`).
4. `handleForeground` with `wasForeground && state === 'connected'` **suspends the healthy session**
   (`src/transport/mobile-relay-reconnect-controller.ts:53-60`). `suspendActiveRelay` early-returns
   unless the active path is `'relay'` (`:77-84`) — which is why LAN hosts never blink.
5. `suspendActiveSession` closes the physical session, disposes all subscriptions, and publishes
   `'disconnected'` (`src/transport/stable-logical-rpc-client.ts:164-180`) → grey dot
   (`src/components/StatusDot.tsx:11`), worktree queries blocked.
6. `onRetry()` → `recoverRelay()` → `openRelay` + `migrateTo`. During the dial the logical state
   **stays 'disconnected'**: `migrateTo` only binds the new session's state after
   `waitForAuthenticated` resolves (`src/transport/stable-logical-rpc-client.ts:188,213`), and the
   dialing session's own `connecting`/`handshaking` publishes (`src/transport/mobile-relay-rpc-session.ts:43,74`)
   fire with no listeners attached. Grey persists the full 1–2s (happy path has no artificial
   delays; any failure adds ≥250ms full-jitter backoff, `src/transport/mobile-relay-retry-delays.ts:3-5`).
7. `migrateTo` completes → `'connected'` → green; subscriptions replay; gated fetches rerun.

Second trigger for the same path: OS network-revival nudges call `notifyForeground()` on every live
client (`src/transport/client-context.tsx:286-292`, `src/transport/connection-revival-triggers.ts`)
— any Wi-Fi↔cellular transition or came-online event grey-blinks every connected relay host.

Design context: the suspend-on-repeat-foreground is pinned by the supervisor test as the
network-handoff half-open case (`src/transport/mobile-endpoint-supervisor.test.ts:~160-197`). The
asymmetry is that **direct sockets probe instead of tearing down** — `notifyForeground` on a
connected direct client runs an activity probe that detects a half-open socket in ≤8s
(`src/transport/rpc-client.ts:1119-1124`) — while relay sessions have a no-op `notifyForeground`
(`src/transport/mobile-relay-rpc-session.ts:106`) and the supervisor's only tool is
suspend-then-redial. There is also an in-repo make-before-break precedent: lease rotation calls
`recoverRelay(forceReplacement = true)` and migrates a **live** session with zero visible blink
(`src/transport/mobile-endpoint-supervisor.ts:56-59,146,249`).

Divergent mount defaults (secondary): home renders `hostStates[id] ?? 'connecting'` (amber,
`app/index.tsx:707`) while `getState()`/`useHostClient` return `'disconnected'` (grey) for a
missing store entry (`src/transport/client-context.tsx:221,344`) — so host screens flash grey
during the async client acquire (Keychain read) that home never shows.

### S3 — silent 5–10s relay-forced pairing

Pairing phase:

1. `pair-confirm.tsx` / `pair-scan.tsx` pass `connectOptions.onLog` into `startPreProfilePairing`
   (`app/pair-confirm.tsx:91-99`, `app/pair-scan.tsx:135-143`).
2. The coordinator threads it **only to the direct candidate**
   (`src/transport/pre-profile-pairing-coordinator.ts:152-157`). The relay candidate
   (`:161-187`) gets nothing: `connectMobileRelayForPairing` has no log parameter at all
   (`src/transport/mobile-relay-physical-client.ts:22-30`), nor do the director resolution,
   journal writes, or the recovery loop in `src/transport/pairing-relay-candidate.ts`.
3. With LAN unreachable, the visible "Pairing log" shows only the direct dial stalling toward its
   12s connect timeout while the relay path does the real work silently: cell WebSocket + E2EE
   handshake + `pairing.provisionRelay` + `pairing.getEndpoints` + credential-bundle write
   (`pre-profile-pairing-coordinator.ts:206-233`). The error copy even says "see log below for
   where it stalled" (`app/pair-confirm.tsx:138`) — the log cannot show it.
4. Un-logged waits in the relay recovery loop: each of up to 3 attempts wraps a 5s director
   resolution (`src/transport/mobile-relay-invite-director.ts:16`) plus full-jitter sleeps capped
   at 100/200/400ms (`src/transport/pairing-relay-candidate.ts:58-59,70-71`) — worst case ~15s of
   silence. (Correction: the preliminary "~3×2s of backoff" was wrong; the sleeps are small, the
   director resolves dominate.) The relay E2EE layer itself has **no timers**: a pairing relay
   request is unbounded except the screen's 25s cap (`app/pair-confirm.tsx:27`).
5. Pairing logs also never reach `connectionLogStore` (single producer:
   `src/transport/client-context.tsx:132`), so the Connection Log screen shows nothing about a
   pairing that just failed.

Post-pairing phase:

6. `pair-confirm` calls `closeHost(hostId)` then replaces to `/h/<id>`
   (`app/pair-confirm.tsx:118-123`).
7. The destination re-acquires a client asynchronously (grey `'disconnected'` default during the
   Keychain read, `src/transport/client-context.tsx:221`), then dials the **LAN endpoint first**
   (`src/transport/host-logical-client.ts:12`) — amber for up to `CONNECT_TIMEOUT_MS = 12s`
   (`src/transport/rpc-client.ts:126`) on a black-holed LAN.
8. Relay recovery cannot start earlier: `needsRecovery` treats `connecting`/`handshaking` as live
   progress (`src/transport/mobile-relay-reconnect-controller.ts:73-75`), checked at supervisor
   start and on every retry (`src/transport/mobile-endpoint-supervisor.ts:106,146`).
9. When the direct dial finally fails, the relay dial runs invisibly (same `migrateTo` mechanism
   as S2) → green. Worst case with a director resolution failure and grace-credential retry:
   ~29–58s under the old session's labels.
10. The "Orca Relay" path label only renders once `state === 'connected'`
    (`src/components/MobileHostCard.tsx:23,47`) — the user learns the phone is using relay only
    after the wait ends, and `classifyConnection` has no relay-aware branch
    (`src/transport/connection-health.ts:45-100`).

## 3. Anti-pattern sweep

### (a) Uncoordinated deep pushes into `/h` from outside the host stack

Coordinated today (mount-then-replace): host edit (`src/transport/host-edit-navigation.ts`) and
Tasks (`src/tasks/mobile-task-navigation.ts`). Note host-edit's predicate is weaker — it checks the
root route only and can fire its `replace` while the nested stack is still gated/unmounted; Tasks
proves the nested stack exists (`mountedHostStack`, `mobile-task-navigation.ts:53-70`).

Bare pushes remaining (host stack plausibly cold at each):

| Call site | Target | Cold scenario |
|---|---|---|
| `app/_layout.tsx:127` via `src/notifications/notification-routing.ts:58,64` | `/h/<id>/session/<wt>` or `/h/<id>` | **Coldest path** — `getLastNotificationResponse()` after launch from a killed app, plus the warm listener |
| `app/index.tsx:740-746` (Resume) | `/h/[hostId]/session/[worktreeId]` | Fixed by PR #12001 |
| `app/index.tsx:835` (Account-usage card) | `/h/<id>/accounts` | Home is the root route |
| `orca://` deep links (scheme in `app.json:9`, no linking config) | any `/h/...` | Default filesystem linking, zero coordination; `app/_layout.tsx:52-58` only intercepts pairing codes |
| `app/h/[hostId]/history/[worktreeId].tsx:15`, `pr/[worktreeId].tsx:16` | redirect to source-control | A cold deep link to these hits the same cold-navigator resolution first |

Shallow index-only pushes (`app/index.tsx:723,803`, onboarding/pair flows) don't need coordination.
No `<Link>`, `navigationRef`, or `router.navigate` anywhere in `mobile/`.

Related hazard: `HostProtocolGate` **unmounts the mounted HostStack mid-connect** for a first-visit
host — stack mounts while `connecting`, is replaced by a spinner when `status.get` goes in flight
(`statusPending` true only when connected: `src/transport/host-status-gates.ts:111`), then remounts
(`src/components/HostProtocolGate.tsx:34-44`). A deep navigation that resolved into the first mount
can be destroyed by the gate cycle.

### (b) Surfaces that render grey 'disconnected' during expected transients

Store defaults: every read API on the canonical store defaults to `'disconnected'` for a missing
entry — `getState` (`src/transport/client-context.tsx:221`), `useHostClient` seed/re-seed/unbound
fallback (`:343-345,377,393`). Exactly one call site defaults to amber instead: the home screen's
`hostStates[id] ?? 'connecting'` (`app/index.tsx:707,903`), whose reconciliation effect also
refuses to write `'disconnected'` for a never-tracked host (`:378-394`) — home already solved
locally what every other surface gets wrong.

The grey window is not one frame: `openEntry` awaits `loadHosts()` (a Keychain/SecureStore pass)
**before** inserting the store entry (`client-context.tsx:87-161`, insert at `:153`), so a cold
start or deep link into `/h/[hostId]` shows grey for the whole Keychain latency. The physical
client is not the cause — it already reports `'connecting'` synchronously by the time `connect()`
returns (`rpc-client.ts:302,967`). Additionally, `forceReconnect` deletes the entry then awaits the
async reopen (`client-context.tsx:201-218`), so **every Retry button drives the UI grey before
amber**.

Surfaces that show grey / "disconnected" copy for a healthy host during these transients (all via
`useHostClient`): host header dot (`app/h/[hostId]/index.tsx:819`); host toolbar + FAB disabled
(`:850-860,941-1000,1063-1078,1209`); the workspace list body renders **nothing at all** for
`disconnected` — `selectHostWorkspaceListState` falls through to `null`, not even a spinner
(`src/worktree/host-workspace-list-state.ts:17-24`); tasks header dot + "Connect to a host" empty
state (`app/h/[hostId]/tasks.tsx:8681,8661-8663`); session dot (no `verdict` prop at all,
`session/[worktreeId].tsx:4434`) and the literal "Disconnected" chip (`:4246-4255`); native-chat
composer lock (`src/session/MobileNativeChatView.tsx:427-432`); source-control / git-history /
diff-review / file-explorer / agent-history "Waiting for desktop…" states; the connection-log
screen prints the raw enum (`app/connection-log.tsx:113-117`); home's Resume/Accounts/Tasks/Quick
Action gates all read `=== 'connected'`; voice settings goes fully inert
(`app/voice-settings.tsx:50-55`). Counter-examples that behave well: home host card, the accounts
screen ("Connecting to {host}…" + cached snapshot, `app/h/[hostId]/accounts.tsx:366-370`).

Deliberate transients that publish `'disconnected'` while healthy work proceeds: relay suspend on
focus/network nudges (S2); background suspend (`src/transport/mobile-endpoint-supervisor.ts:123` —
correct per billing, but state stays grey through the entire foreground re-dial rather than
flipping to `'connecting'`); post-migration cleanup (`:251-253`); `closeHost` during the
pair-confirm handoff (`src/transport/client-context.tsx:83`); three open-failure paths
(`:107,114,135`).

Destructive companion pattern — state flips don't just recolor, they **wipe loaded data**:
`host-status-gates.ts:32,100-112` wipes cached host capabilities on every disconnect;
`tasks.tsx:2774-2800` resets the whole screen's hydration and force-closes ~15 sheets;
`session/[worktreeId].tsx:2043,2432-2439,3713-3716` clears diff comments/capability flags/agent
lists; the PR sidebar hides entirely (`src/session/use-mobile-pr-branch-context.ts:59-66` →
`use-mobile-pr-sidebar-controller.ts:113-118`); git history blanks rows on the **reconnect** branch
(`src/source-control/MobileGitHistoryList.tsx:63-68`); the repo cache survives disconnect but is
wiped by the rejected in-flight call (`NewWorktreeModal.tsx:330-333`); the worktree cache is read
only at mount/hostId change (`app/h/[hostId]/index.tsx:129,330`), never on reconnect, so a >30s
entry means an empty remount.

Same bug class in a second enum: `workspaceSshStatusLabel` defaults a `null` SSH status to
"Disconnected" (`src/tasks/workspace-ssh-gate.ts:14-37`, rendered in `NewWorktreeModal.tsx:863`
and `tasks.tsx:10970`).

### (c) Invisible relay establishment phases

- `connectMobileRelayRpcSession` (normal relay connects) has **no onLog** — the entire relay
  session lifecycle emits nothing (`src/transport/mobile-relay-rpc-session.ts:30-39`); the
  supervisor logs only coarse post-hoc lines (`mobile-endpoint-supervisor.ts:185-188,261`).
- `migrateTo` structurally discards the dialing session's `connecting`/`handshaking` states
  (`src/transport/stable-logical-rpc-client.ts:182-223,267-299`).
- Direct→relay upgrade path has no sink at all (`src/transport/mobile-endpoint-lifecycle.ts:49-58`,
  `mobile-relay-direct-upgrade-controller.ts:19`).
- Pairing relay path fully silent (S3 above); pairing logs never reach `connectionLogStore`.
- Path label ("Orca Relay") gated on `connected` (`src/components/MobileHostCard.tsx:47`);
  `classifyConnection` collapses `connecting`/`handshaking`/`reconnecting` and has no relay branch.
- Regression suite for connect-label stalls exists for the direct path only
  (`src/transport/cellular-connecting-label-stall.test.ts`); no relay equivalent.

## 4. Fix plan

Ordered by felt-flakiness-removed per unit risk. All fixes are phone-local; none change the wire
protocol, so every old/new phone × old/new desktop pairing keeps working unless noted.

### F0 (S1, quick win) — land PR #12001 ✅ MERGED

Squash-merged to main as `7948e46db855` (2026-08-04) after validation: CI fully green; drift check
against current main clean (only overlap, #12575, touches different regions of `app/index.tsx` and
auto-merges); full mobile suite (411 files, 3110 tests) passed on a local merge of main into the PR
branch. The PR routes Resume through the shared mount-then-replace mechanism
(`src/navigation/host-stack-navigation.ts`) and adds a source-guard test against reintroducing the
bare push. This branch has since been fast-forwarded onto that merge, and F4 builds on the
extracted module.
Backward compat: navigation-only, none.
Residuals tracked as F4/F7/F8/F9.

### F1 (S2, quick win) — stop suspending a healthy relay on focus ✅ IMPLEMENTED (this branch)

Approach: split the nudge reasons that today all funnel into `setForeground(true)`:

- Screen-focus nudge (`app/h/[hostId]/index.tsx:515`): must not suspend. For the relay path, either
  no-op (state changes already drive the UI) or run a cheap liveness probe (an RPC with a short
  budget) and only enter recovery on failure — mirroring the direct path's activity probe.
- Network-change / app-resume nudges: keep half-open protection, but **verify by replacement**
  instead of break-before-make: call the existing `recoverRelay(forceReplacement = true)` path
  (proven by lease rotation) so `migrateTo` swaps sessions with the dot staying green; only if the
  replacement dial fails, fall back to `suspendActiveRelay` so a genuinely dead link stops lying
  green and the retry loop re-arms (plain `recoverRelay` early-returns while the stale state is
  still `'connected'`, so the fallback suspend is required for convergence).

Files: `src/transport/mobile-relay-reconnect-controller.ts` (`handleForeground`),
`src/transport/mobile-endpoint-supervisor.ts` (thread a nudge reason; failure-path suspend),
`src/transport/mobile-endpoint-lifecycle.ts`, `src/transport/host-logical-client.ts` (reason-tagged
`notifyForeground`), optionally `src/transport/rpc-client.ts` type for the reason parameter.
Risk: PEER_DROPPED/LIMIT_EXCEEDED churn if replacement dials overlap — reuse the existing
`shouldDefer` cooldown; billed duplicate socket for the overlap window (lease rotation already
accepts this). Half-open regression risk is covered by the fallback suspend.
Tests: split `mobile-endpoint-supervisor.test.ts:~160-197` into (focus nudge → no suspend, dot
stays green) and (network handoff → replacement dial; failure → suspend + cooldown). Keep the
background-suspend test unchanged.

### F2 (S2/S3, quick win) — unify mount defaults to 'connecting' ✅ IMPLEMENTED (this branch)

Approach: `getState(hostId)` returns `'connecting'` when the host is known (primed profile or
pending open) and no entry exists yet; `'disconnected'` only for unknown/closed hosts. Aligns every
host screen with home's `?? 'connecting'`. Two companion changes in the same class:
- `forceReconnect` should notify `'connecting'` (or insert a placeholder entry) instead of leaving
  the deleted-entry window grey (`src/transport/client-context.tsx:201-218`) — every Retry button
  currently drives the UI grey before amber.
- Optionally have `openEntry` insert a `'connecting'` placeholder before the Keychain read so the
  cold-start gap (`client-context.tsx:87-153`) is amber too.

**Required interaction fix**: `app/h/[hostId]/index.tsx:738-741` falls back to
`lastKnownWorktrees` only for `disconnected | reconnecting | auth-failed`; `connecting`/
`handshaking` fall through to the live (empty on fresh mount) array. Flipping the default without
extending that predicate would silently disable the stale-list fallback and blank the list —
extend it to every not-connected state (or key it on "no live fetch has succeeded this mount").
Files: `src/transport/client-context.tsx` (`getState`, `useHostClient`, `forceReconnect`,
`openEntry`), `app/h/[hostId]/index.tsx` (fallback predicate),
`src/worktree/host-workspace-list-state.ts` (render a spinner for the not-connected states instead
of `null`).
Risk: a permanently unreachable host now shows amber briefly before the verdict system escalates —
acceptable; `classifyConnection` already owns escalation. Audit the §3(b) "wipe" sites for any that
key on `'disconnected'` specifically.
Tests: `client-context.test.ts` known-vs-unknown host defaults + forceReconnect state sequence;
host screen test for the stale-list fallback under `'connecting'`.

### F3 (S3, quick win) — give the pairing relay path a log sink ✅ IMPLEMENTED (this branch)

Approach: add an optional `onLog` to `connectMobileRelayForPairing`,
`createRecoveringPairingRelayCandidate`, and `resolvePairingInviteThroughDirector`; thread
`connectOptions.onLog` from the coordinator to the relay candidate; emit phase lines ("relay:
resolving director…", "relay: cell connected", "relay: E2EE handshake…", "relay: authenticated",
"relay: installing credential…"). Optionally also append pairing logs into `connectionLogStore`
under the resolved host id so the Connection Log screen has a record post-pairing.
Files: `src/transport/mobile-relay-physical-client.ts`, `pairing-relay-candidate.ts`,
`mobile-relay-invite-director.ts`, `pre-profile-pairing-coordinator.ts`.
Risk: none (additive, phone-local). Old desktops: unaffected — logging only.
Tests: coordinator test asserting relay-path log entries arrive through `connectOptions.onLog`;
extend `pairing-relay-candidate.test.ts` for per-attempt lines.

### F4 (S1 class, quick win after F0) — coordinate the remaining bare deep pushes

Approach: route notification taps (`app/_layout.tsx:127` + `src/notifications/notification-routing.ts`)
and the Account-usage card (`app/index.tsx:835`) through `src/navigation/host-stack-navigation.ts`
once #12001 lands; migrate host-edit onto the same stricter mechanism (#12001's own noted
follow-up). `orca://` deep links can follow later via a route-level guard.
Risk: notification cold-start ordering (push before root nav ready) — the mechanism already
tolerates that by waiting for state commits.
Tests: reuse the `host-stack-navigation.test.ts` harness for a notification-shaped target.

### F5 (S2/S3, deeper) — make relay dials visible through `migrateTo`

Approach: while the logical client is `suspended`/`'disconnected'`, have `migrateTo` forward the
dialing session's state publishes (`connecting`/`handshaking`) to `publishState`, unbinding on
success (normal bind takes over) or failure (restore `'disconnected'`). Guard: never downgrade a
still-`'connected'` previous session (make-before-break migrations must stay green). Follow-on UI:
show the path being dialed ("Connecting via Orca Relay…") by exposing the pending path, and let
`MobileHostCard`/`classifyConnection` render it while not yet connected.
Files: `src/transport/stable-logical-rpc-client.ts` (+ its test), `src/transport/connection-health.ts`,
`src/components/MobileHostCard.tsx`, `src/transport/mobile-connection-path-label.ts`.
Risk: state-ordering regressions in the pinned stable-client and connecting-label suites; keep the
forwarding strictly gated on suspended/disconnected.
Tests: add a relay-path analog of `cellular-connecting-label-stall.test.ts`; stable-client cases:
forwarded states during suspended dial, no forwarding during live-session replacement, failure
restores `'disconnected'`.

### F6 (S3, deeper) — happy-eyeballs relay start post-pairing

Approach: when a relay credential bundle exists and the direct dial has not authenticated within a
short grace (2–3s), start the relay dial in parallel instead of waiting for the 12s direct failure;
first authenticated path wins via the existing `migrateTo`/hysteresis machinery. Scope initially to
the first connect after pairing (or hosts whose last success was relay) to avoid pointless relay
sockets on healthy LANs.
Files: `src/transport/mobile-endpoint-supervisor.ts` (start/needsRecovery gating), possibly a
phone-local `HostProfile` hint field (no protocol impact; old desktops never present `relay`, so
the path is naturally guarded).
Risk: racing direct is exactly what `needsRecovery`'s design avoids — needs the mutex
(`operationInFlight`) audit and dwell/hysteresis respect; billed relay data on LANs if scoped too
broadly.
Tests: supervisor fake-timer cases: black-holed LAN converges in ~3-5s; healthy LAN never opens a
relay socket; relay loser closed after direct wins.

### F7 (S1, deeper) — catalog-validate resume targets + not-found bounce

Approach: (1) on Resume tap with the host connected, validate the target against the freshest
`worktree.ps` result (not the snapshot-seeded cache); if absent, open the host index instead.
(2) In the session screen, once connected and the catalog is known, bounce unknown `worktreeId`s
(exempting `folder:` and floating-workspace sentinels, `app/h/[hostId]/session/[worktreeId].tsx:852-854`)
to the host index with a notice. (3) Use the validating reader in
`src/worktree/last-visited-worktree-repo.ts` on home instead of the raw `JSON.parse`
(`app/index.tsx:315-322`), and import the storage-key constant at both literal call sites.
Risk: false bounces during slow catalog loads — only bounce on a *confirmed* fresh catalog miss.
Tests: repo tests for the validating reader on home; session-screen bounce cases incl. sentinel
exemptions.

### F8 (S1 aggravator, cheap) — stop the Resume/Tasks layout shift

Approach: reserve the Resume card's slot (fixed-height placeholder or render-below-Tasks) so its
late arrival cannot move the Tasks card under the thumb; alternatively render the card immediately
from the snapshot in a disabled state until the host connects.
Files: `app/index.tsx` footer.
Risk: none.
Tests: render test asserting footer order/height stability across `resumeWorktree` arrival.

### F9 (S1 class, deeper) — HostProtocolGate should not unmount a mounted stack

Approach: once the HostStack has mounted for a host, keep it mounted and overlay the pending
spinner instead of replacing children, preserving in-flight nested navigation; keep the hard
replace only for the `blocked` verdict.
Files: `src/components/HostProtocolGate.tsx`.
Risk: the gate exists so child routes don't call too-new RPCs while compatibility is unknown — an
overlay must still block interaction until resolved; verify child mount effects don't fire gated
RPCs pre-verdict before choosing overlay vs. current behavior.
Tests: gate test asserting no unmount across `statusPending` for an already-mounted host.

### F10 (S2 class, deeper) — stop wiping loaded data on transient state flips

Approach: audit the §3(b) destructive-clear sites and make each preserve data across a
not-`'connected'` blip, clearing only on host change or explicit sign-out. Top offenders by felt
impact: git history blanking rows on the reconnect branch
(`src/source-control/MobileGitHistoryList.tsx:63-68` — refetch without `setRows(null)`); the repo
cache wiped by the rejected in-flight call (`NewWorktreeModal.tsx:330-333` — keep last-good on
error); the diff-review "ready-state preserved" branch that is dead code because it sits after the
early return (`src/session/use-mobile-diff-review-controller.ts:85-89`); host capability wipe
(`src/transport/host-status-gates.ts:32`); the tasks-screen full re-hydration
(`app/h/[hostId]/tasks.tsx:2774-2800`); worktree-cache re-read on reconnect, not only at mount
(`app/h/[hostId]/index.tsx:129,330`).
Risk: showing stale data as if live — pair each preservation with the existing staleness verdicts
rather than inventing new indicators. The in-repo reference pattern is
`src/worktree/home-worktree-info.ts:27-47`: counts older than a 10min TTL render as
"Last known: N worktrees" instead of being dropped, and `markHomeWorktreeCatalogUnavailable`
preserves proven counts across a failed refresh, flagging only `staleCounts`.
Tests: per-surface "data survives disconnect→reconnect" cases; F1 largely removes the *trigger*
(suspend blips), so this is hardening, not the primary fix.

## 5. Backward compatibility (old/new phone × old/new desktop)

- Every fix above is phone-app-local; no RPC methods, close codes, credential formats, or pairing
  steps change. Old phones against any desktop are untouched (they don't have the code).
- New phone + old desktop without relay support: `host.relay` is absent → F1/F5/F6 relay paths
  never activate; pairing keeps the existing `method_not_found` downgrade
  (`src/transport/pre-profile-pairing-coordinator.ts:210-217`); F3 logging is inert (no relay
  candidate is created).
- New phone + old desktop with relay: all paths use existing RPCs (`status.get`,
  `pairing.provisionRelay`, resume confirm) — no new calls introduced. F1's replacement dial reuses
  the same resume-credential flow lease rotation already exercises against production desktops.
- F6's profile hint (if added) is a phone-local persisted field; absent values behave as today.

## 6. Constants appendix (verified)

| Constant | Value | Where |
|---|---|---|
| Direct connect timeout | 12s | `src/transport/rpc-client.ts:126` |
| Direct handshake timeout | 5s | `rpc-client.ts:127` |
| Direct reconnect ladder | 0.5→60s, give up 12, trickle 90s | `rpc-client.ts:113-117` |
| `migrateTo` auth timeout | 12s | `src/transport/stable-logical-rpc-client.ts:182` |
| Relay backoff | 250ms floor, 500ms base, 30s ceiling, full jitter | `src/transport/mobile-relay-retry-delays.ts:3-5` |
| Host-offline relay retry | 5–15s | `mobile-relay-retry-delays.ts:7-8` |
| Gate reprobe cadence | 60s→15min | `mobile-relay-retry-delays.ts:13-14` |
| Director resolve timeout | 5s (invite & resume) | `mobile-relay-invite-director.ts:16`, `mobile-relay-resume-director.ts:21` |
| Pairing relay recovery | ≤3 attempts × (5s director + ≤100/200/400ms jitter) | `src/transport/pairing-relay-candidate.ts:42,58-71` |
| Pairing overall cap | 25s | `app/pair-confirm.tsx:27` |
| Relay E2EE layer timers | none | `mobile-relay-e2ee-link.ts`, `mobile-e2ee-v2-*.ts` |
| Worktree cache TTL | 30s from write/seed | `src/cache/worktree-cache.ts:12` |
| Direct activity probe (foreground) | detects half-open ≤8s | `rpc-client.ts:1119-1124` |
