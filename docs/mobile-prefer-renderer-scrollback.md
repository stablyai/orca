# Mobile scrollback parity: hydrate headless emulator from renderer on first PTY data

## Problem

When a mobile companion client subscribes to a terminal, it sees substantially less scrollback than the desktop renderer for the same PTY. In the worst case observed (a `claude`-then-shell session in the `edit-issues` worktree), the desktop shows ~30 lines of post-exit agent summary while mobile shows a single bare prompt.

The mismatch is reproducible and not a transient race: it persists across resubscribes, app return-from-background, and PTY-clean shell prompts.

## Where data lives today

Two separate xterm.js instances exist for every connected PTY:

1. **Renderer xterm** — owned by `TerminalPane` in the renderer process. Created when the user mounts the pane. Listens to `pty:data` IPC for the lifetime of the pane. 50,000-row scrollback. Source of truth for the visible desktop terminal.

2. **Runtime headless emulator** — `HeadlessEmulator` in `src/main/runtime/orca-runtime.ts`. Created lazily on first `runtime.onPtyData(ptyId, …)` call. 5,000-row scrollback. Used to serve `terminal.read`, `terminal.subscribe`, `lastAgentStatus`, and TUI-idle detection. This is what mobile, the CLI, and any non-renderer consumer get.

| Consumer | Reads from | Lifetime |
|---|---|---|
| Desktop pane | Renderer xterm | Pane mount → unmount |
| Mobile (`terminal.subscribe`) | Headless emulator (primary), renderer (fallback) | Runtime startup → PTY exit |
| `terminal.read` (CLI / agent) | Headless emulator | Runtime startup → PTY exit |
| `lastAgentStatus` | Headless emulator (via OSC detection on `onPtyData`) | Runtime startup → PTY exit |

The two xterms are fed by the same provider stream but are "born" at different moments:

- The renderer xterm gets hydrated on attach via cold-restore data (`result.coldRestore.scrollback`) or warm reattach (`result.snapshot`) in `pty-connection.ts`, plus all live bytes since.
- The headless emulator only sees bytes that flow through `runtime.onPtyData` since *runtime* startup. After an Orca relaunch, the headless emulator starts empty and only catches up on new live data; it never replays the cold-restore payload.
- Commit `8a5ea4b7` added `seedHeadlessTerminal(ptyId, data, size?)` which runs from `ipc/pty.ts` on `provider.spawn` and seeds the emulator from `result.snapshot` / `result.coldRestore.scrollback`. That helps daemon-restored sessions but **does not help when the daemon's persisted state is itself near-empty** — the `edit-issues` reproduction has `checkpoint.json` with `scrollbackAnsi: ""` because the daemon checkpoint only stores the visible screen, not real scrollback.

So the dominant residual case is: daemon checkpoint is near-empty, the user opens a desktop pane (which hydrates from the live PTY post-spawn and accumulates a rich 50k-row buffer), then the user opens mobile — and mobile reads from the headless emulator, which has only seen bytes since runtime startup with nothing to replay.

## Goal

Mobile, CLI, and `lastAgentStatus` should display the same scrollback as the desktop renderer for any PTY whenever the user has a desktop pane mounted for it. The fix must:

- Be a small, targeted change to the runtime (no daemon, IPC schema, or persistence-format changes).
- Not regress the "no desktop pane mounted" cases (background terminals, headless agent runs, CLI on a freshly-restored daemon).
- Not introduce reflow / SGR drift between desktop and mobile.
- Not introduce a per-keystroke or per-subscribe renderer round-trip on the hot path.
- Reinforce — not violate — the existing invariant that the main process is authoritative for terminal state served to mobile/CLI/`terminal.read`.

## Non-goals

- **Mobile-only-after-relaunch (Scenario A).** A user who relaunches Orca and opens mobile *without* ever opening the desktop pane will still see only what the daemon checkpoint stored (often the visible screen and nothing more). Solving this requires daemon-side persisted scrollback, which is a separate, larger effort with its own privacy, format-stability, retention, and IO-cost considerations. This design explicitly does not solve Scenario A.
- Persisting full scrollback to disk (the "option 2" architecture).
- Unifying the renderer and headless emulators into a single main-process service.
- Changing mobile's xterm-side replay logic. Today it correctly handles either source.
- Changing the read-priority order in `serializeTerminalBufferFromAvailableState`. Headless stays primary; renderer stays the no-headless fallback.

## Proposed change

When the runtime first sees `pty:data` for a `ptyId` that already has a renderer pane registered (detected via a new `ptyController.hasRendererSerializer(ptyId)` predicate, backed by the `serializersByPtyId` registry in `pty-buffer-serializer.ts`), perform a one-time IPC round-trip to the renderer, get its serialized buffer, and seed the headless emulator with it **before** writing the live byte that just arrived. Subsequent `pty:data` calls for the same `ptyId` skip hydration via a per-PTY guard. If no renderer serializer is registered yet on the first byte, the guard is left absent so a later byte can retry once the pane mounts.

This is structurally the same operation `seedHeadlessTerminal` already does on `provider.spawn` from daemon-restored state. The new path covers the gap the existing seeding doesn't: the renderer has a richer buffer than the daemon does, and we want that richer buffer mirrored into the headless emulator on first runtime touch.

After hydration, all consumers (`terminal.read`, `terminal.subscribe`, `lastAgentStatus`, mobile, CLI) get the same fuller scrollback through the existing read paths. No priority flip is required. No per-consumer fallback. No per-subscribe IPC.

### System context — before

```
                    ┌─────────────────────────────────────────────┐
                    │  Renderer process                           │
                    │                                             │
                    │   TerminalPane → xterm.js (50k rows)        │
                    │     ▲                                       │
                    │     │ replayIntoTerminal(coldRestore.       │
                    │     │   scrollback) on pane mount           │
                    │     │ + live pty:data writes                │
                    └─────┼───────────────────────────────────────┘
                          │
                  pty:data│IPC
                          │
                    ┌─────┴───────────────────────────────────────┐
                    │  Main process                               │
                    │                                             │
                    │   ipc/pty.ts (provider.spawn)               │
                    │     ├─→ seedHeadlessTerminal(snapshot)      │
                    │     │      ↓                                │
                    │     │   HeadlessEmulator (5k rows) ───┐     │
                    │     │      ▲                          │     │
                    │     │      │ trackHeadlessTerminalData│     │
                    │     │      │ on every onPtyData       │     │
                    │     └─→ runtime.onPtyData(...)────────┘     │
                    │                                       ▼     │
                    │                       serializeHeadless     │
                    │                       (primary read source) │
                    │                              │              │
                    │                              ▼              │
                    │                   mobile / CLI / lastStatus │
                    └─────────────────────────────────────────────┘
                          ▲
                  pty:data│from daemon
                          │
                    ┌─────┴───────────────────────────────────────┐
                    │  Daemon                                     │
                    │   checkpoint.json (visible screen only)     │
                    └─────────────────────────────────────────────┘

Bug: when daemon checkpoint is near-empty but the renderer xterm has
accumulated a rich live buffer, mobile reads from the headless emulator
which only saw bytes since runtime startup — and so sees less than desktop.
```

### System context — after

```
                    ┌─────────────────────────────────────────────┐
                    │  Renderer process                           │
                    │                                             │
                    │   TerminalPane → xterm.js (50k rows)        │
                    │     │ ▲                                     │
                    │     │ │ unchanged hydration path            │
                    │     │ └─── live pty:data writes             │
                    │     │                                       │
                    │     │ ptyController.serializeBuffer(ptyId)  │
                    │     │ called ONCE per (ptyId, runtime)      │
                    │     │ on first onPtyData                    │
                    │     ▼                                       │
                    └─────┼───────────────────────────────────────┘
                          │
                  pty:data│IPC + one-time serialize round-trip
                          │
                    ┌─────┴───────────────────────────────────────┐
                    │  Main process                               │
                    │                                             │
                    │   onPtyData(ptyId, data) (first time)       │
                    │     ├─→ if ptyController.serializeBuffer    │
                    │     │     returns non-empty:                │
                    │     │       hydrateHeadlessFromRenderer →   │
                    │     │       seedHeadlessTerminal(rendered)  │
                    │     │     mark hydrated                     │
                    │     ├─→ trackHeadlessTerminalData(data)     │
                    │     │   (chained via writeChain after seed) │
                    │     │                                       │
                    │   HeadlessEmulator (5k rows, now seeded     │
                    │     with renderer's view)                   │
                    │       ↓                                     │
                    │   serializeHeadless (UNCHANGED PRIMARY)     │
                    │       ↓                                     │
                    │   mobile / CLI / lastAgentStatus / read     │
                    └─────────────────────────────────────────────┘

Read priorities are unchanged. Headless emulator is still the primary
source of truth; renderer is consulted exactly once, at hydration time,
not per consumer or per subscribe.
```

### Ordering invariant (DO NOT REORDER)

In `onPtyData(ptyId, data, at)`, the call sequence is:

```ts
this.agentDetector?.onData(ptyId, data, at)
this.maybeHydrateHeadlessFromRenderer(ptyId)   // ← MUST come BEFORE
this.trackHeadlessTerminalData(ptyId, data)    // ← this line
```

**`maybeHydrateHeadlessFromRenderer` MUST be invoked before `trackHeadlessTerminalData`.** If reordered, `trackHeadlessTerminalData`'s lazy-create branch will populate `headlessTerminals` with a fresh empty emulator first, and `maybeHydrateHeadlessFromRenderer`'s `!headlessTerminals.has(ptyId)` precondition (the "live bytes already arrived" guard) will short-circuit — silently disabling hydration for the lifetime of the PTY. There is no test that catches this regression cheaply (the failure mode is "less scrollback than expected", which is the original bug); the guarantee lives in the call-site comment in `orca-runtime.ts`.

A `// DO NOT REORDER — see "Ordering invariant" in mobile-prefer-renderer-scrollback.md` comment is mandatory at this call site.

### Pseudocode

```ts
// Per-PTY hydration tracker. Key absent = idle (next byte may attempt).
// 'pending' = round-trip in flight; 'done' = succeeded or unrecoverably
// finished; 'skipped' is no longer used — instead we leave the key absent
// when the precondition fails so a later byte can retry.
private headlessHydrationState = new Map<string, 'pending' | 'done'>()

onPtyData(ptyId: string, data: string, at: number): void {
  this.agentDetector?.onData(ptyId, data, at)
  this.maybeHydrateHeadlessFromRenderer(ptyId)
  this.trackHeadlessTerminalData(ptyId, data)
  // …existing OSC / tail / leaf bookkeeping unchanged
}

private async maybeHydrateHeadlessFromRenderer(ptyId: string): Promise<void> {
  if (this.headlessHydrationState.has(ptyId)) return
  if (this.headlessTerminals.has(ptyId)) {
    // Live bytes already arrived for this ptyId — re-seeding now would
    // duplicate them. Mark done; never retry. (Daemon-snapshot seeding
    // is handled separately: see "Cooperation with seedHeadlessTerminal"
    // — that path is gated on `!hasRendererSerializer(ptyId)` so it does
    // not pre-empt this hydration when a renderer pane is mounted.)
    this.headlessHydrationState.set(ptyId, 'done')
    return
  }
  // Why: leave the state absent (not 'done') when there's no renderer
  // serializer or controller. The pane may mount one byte later; the
  // next onPtyData call gets another chance. This is the contract change
  // motivated by Open Question P2-2.
  if (!this.ptyController?.serializeBuffer) return
  if (!this.ptyController.hasRendererSerializer?.(ptyId)) return  // not yet registered

  this.headlessHydrationState.set(ptyId, 'pending')

  // Why: eagerly create the headless state at PTY dims so concurrent live
  // writes from trackHeadlessTerminalData chain onto the same writeChain.
  // This matches seedHeadlessTerminal's pattern (orca-runtime.ts:780-803);
  // without it, a live byte arriving during the serializeBuffer await would
  // lazy-create a separate state that we'd later overwrite, dropping the
  // live byte.
  const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
  const state: RuntimeHeadlessTerminal = {
    emulator: new HeadlessEmulator({ cols: dims.cols, rows: dims.rows }),
    writeChain: Promise.resolve()
  }
  this.headlessTerminals.set(ptyId, state)

  // Why: append the renderer-fetch + seed-write to the chain. Live writes
  // that arrive before the chain head resolves are queued behind it via
  // trackHeadlessTerminalData's existing `state.writeChain.then(...)` pattern.
  state.writeChain = state.writeChain.then(async () => {
    try {
      const rendered = await this.ptyController!.serializeBuffer!(ptyId, {
        scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS,
        altScreenForcesZeroRows: true
      })
      if (!rendered || rendered.data.length === 0) {
        this.headlessHydrationState.set(ptyId, 'done')
        return
      }
      // Why: resize to the renderer's reported dims before writing the seed
      // so the serialized layout reflows correctly. Then resize back to the
      // PTY's current dims after the seed lands so subsequent live writes
      // use the right cell grid.
      state.emulator.resize(rendered.cols, rendered.rows)
      await state.emulator.write(rendered.data)
      const ptyDims = this.getTerminalSize(ptyId)
      if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
        state.emulator.resize(ptyDims.cols, ptyDims.rows)
      }
      // Why: status parity. SerializeAddon does NOT round-trip OSC 0/1/2
      // title bytes, so extracting from rendered.data would always be null.
      // applySeededAgentStatus runs detectAgentStatusFromTitle and writes
      // leaf.lastAgentStatus only when the result is non-null; it MUST NOT
      // call resolveTuiIdleWaiters or deliverPendingMessages because seed-
      // derived status reflects historical state.
      if (rendered.lastTitle) {
        this.applySeededAgentStatus(ptyId, rendered.lastTitle)
      }
    } catch {
      // Hydration is best-effort. Live writes continue via the same
      // writeChain that this catch-arm leaves intact.
    } finally {
      this.headlessHydrationState.set(ptyId, 'done')
    }
  })
}
```

**Eager-state ordering invariant.** Even though the chain head blocks live writes until the seed completes, the LIVE BYTE ITSELF (the one that triggered `onPtyData`) is enqueued onto `state.writeChain` BY `trackHeadlessTerminalData` AFTER `maybeHydrateHeadlessFromRenderer` returns synchronously and registers its seed-write link. The live byte's chain link executes after the seed-write resolves. That is the ordering invariant the eager-state pattern preserves.

**Resize-during-hydration note.** `resizeHeadlessTerminal` (orca-runtime.ts:828) deliberately bypasses `writeChain` and calls `state.emulator.resize(...)` directly — that's existing behavior we preserve. If a `pty:resize` IPC arrives during the hydration window (between `headlessTerminals.set` and `seedPromise` resolution), the resize lands on the emulator while the seed-write is mid-flight; this can produce a one-frame visual artifact in the seed but cannot corrupt subsequent live writes (which the seed-then-resize-back invariant restores). The narrow window — typically <200ms — is bounded by the renderer-IPC round-trip duration.

The cap and alt-screen rule on the renderer side mirror `serializeHeadlessTerminalBuffer`: 1000-row limit on rehydration payload, force `scrollbackRows = 0` when the renderer xterm reports `buffer.active.type === 'alternate'`. This unifies semantics between hydration source and live-serialize source — the user sees the same depth regardless of which path served them, and an alt-screen TUI never bleeds normal-buffer scrollback into the seed.

### IPC contract changes

Hydration relies on the renderer-side serializer accepting an option bag. Today the chain is single-arg end to end, so changes must land in lockstep:

- `src/preload/index.ts` — the `pty:serializeBuffer:request` payload extends to `{ requestId, ptyId, opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean } }`. Renderer-side type for the listener callback widens accordingly.
- `src/main/ipc/pty.ts` — `requestSerializedBuffer(ptyId, opts?)` accepts the opts object and forwards it on the IPC `webContents.send` payload. Snapshot-shape validation widens to accept an optional `lastTitle: string`. Existing 750 ms timeout unchanged.
- `src/main/runtime/orca-runtime.ts` — the `RuntimePtyController.serializeBuffer?` signature widens to `(ptyId, opts?) => Promise<{ data: string, cols: number, rows: number, lastTitle?: string } | null>`. A new optional `hasRendererSerializer?(ptyId): boolean` lets the runtime check pane mount status before paying the IPC cost (implementation: a getter against `serializersByPtyId` in `pty-buffer-serializer.ts`).
- `src/renderer/src/components/terminal-pane/pty-buffer-serializer.ts` — the registered `SerializeFn` widens to `(opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }) => Promise<{ data, cols, rows, lastTitle?: string } | null> | …`. The pane's serializer reads the opts: if `altScreenForcesZeroRows && pane.terminal.buffer.active.type === 'alternate'`, call `pane.serializeAddon.serialize({ scrollback: 0 })`; otherwise `pane.serializeAddon.serialize({ scrollback: opts?.scrollbackRows })`. The response payload includes `lastTitle: lastTitleByPtyId.get(ptyId)?.title` (omitted when no title has been observed for this PTY). Default behavior (no opts) preserves today's full-buffer serialize for any caller that hasn't migrated.
- `serializeTerminalBufferFromAvailableState` (the renderer-fallback read path in `orca-runtime.ts:843`) forwards `scrollbackRows` so the fallback's depth matches the primary path. **It does NOT pass `altScreenForcesZeroRows: true`** — see "alt-screen flag scoping" below.

**alt-screen flag scoping (only on hydration path).** `altScreenForcesZeroRows: true` is passed ONLY by `maybeHydrateHeadlessFromRenderer` (the hydration path). The read-fallback path (`serializeTerminalBufferFromAvailableState`) passes `altScreenForcesZeroRows: false` (or omits the flag, default false). Reasoning:

- **Hydration:** wants the *normal* buffer's scrollback. xterm discards alt-screen content when alt-screen exits anyway, so suppressing scrollback during alt-screen prevents transient TUI bytes from bleeding into the seed that the headless emulator will hold for the rest of the session.
- **Read fallback:** is invoked by `terminal.read` / `terminal.subscribe` for an actively-running TUI when the headless emulator returned null. The caller wants whatever is currently visible — including alt-screen content — so suppressing it would produce a worse result than today.

Both call sites pass explicit opts in the pseudocode (no implicit defaults relied on). The read-fallback shape:

```ts
// In serializeTerminalBufferFromAvailableState (read-fallback):
rendererSnapshot = await (this.ptyController?.serializeBuffer?.(ptyId, {
  scrollbackRows: opts.scrollbackRows,
  altScreenForcesZeroRows: false  // read-fallback wants visible alt-screen content
}) ?? Promise.resolve(null))
```

### Renderer-side prerequisite

Today, `registerPtySerializer(ptyId, …)` is only called inside `handleReattachResult` (`pty-connection.ts:571`). Fresh spawns — the dominant case — never register, so `hasRendererSerializer(ptyId)` would always return false and hydration would no-op. The renderer change required:

- Move (or duplicate) the `registerPtySerializer` call so it fires for **both** reattach and fresh spawn paths. Cleanest shape: extract the body (closure capturing `pane`, `deps.pendingWritesRef`, `deps.replayingPanesRef`) into a `registerPaneSerializerFor(ptyId)` helper and call it from `handleReattachResult` AND from `startFreshSpawn`'s `.then(spawnedPtyId => …)` once a `ptyId` is known.
- The helper accepts the new `opts` arg and threads it into `pane.serializeAddon.serialize({ scrollback: … })` per the IPC contract above.

**Cleanup contract & StrictMode safety.** Two requirements, both motivated by React 18 StrictMode double-mount and async pane disposal:

1. **`if (disposed) return` guard at the top of every post-spawn registration call** (both reattach and fresh-spawn paths). Rationale: StrictMode mounts the pane twice; the first mount is disposed before the second runs, but its `pty:spawn` IPC may have already resolved by the time `disposed` flips to true. Without the guard, the disposed first mount would call `registerPaneSerializerFor` after teardown — replacing the live registration from the second mount or registering a closure over a torn-down `pane.terminal`.

2. **Unregister via ownership token, not unconditional delete.** `serializersByPtyId` becomes `Map<ptyId, { fn: SerializeFn, owner: symbol }>`. Each call to `registerPtySerializer` mints a fresh `owner` symbol and returns an unregister closure that **only deletes the entry when the current entry's `owner === thisOwner`**. If a later registration has overwritten the entry (StrictMode second mount, fast pane swap), the unregister is a no-op so the live registration is preserved. The body of the unregister closure also clears any module-level state keyed off the same owner (lastTitle bookkeeping introduced below) AND disposes the xterm `onTitleChange` IDisposable that was installed at register time.

   ```ts
   export function registerPtySerializer(ptyId, fn): () => void {
     const owner = Symbol(ptyId)
     serializersByPtyId.set(ptyId, { fn, owner })
     ensureSerializerListener()
     return () => {
       const current = serializersByPtyId.get(ptyId)
       if (current?.owner === owner) {
         serializersByPtyId.delete(ptyId)
       }
     }
   }
   ```

3. **Spawn-rejection cleanup is mandatory.** The renderer MUST call `pty:clearPendingPaneSerializer(paneKey, gen)` from the catch-arm of `pty:spawn` AND from pane unmount AFTER pre-signal but BEFORE settle. Without this, a failed-spawn paneKey leaks a pending intent that suppresses the next legitimate daemon-snapshot seed for that paneKey.

4. **Pre-signal applies to BOTH fresh-spawn AND reattach paths.** `declarePendingPaneSerializer(paneKey)` is mandatory on both — mirroring the `registerPaneSerializerFor(ptyId)` requirement. Reattach paths today already register the serializer in `handleReattachResult`, but the pre-signal must also fire on the reattach path so the cooperation gate in `pty:spawn` behaves consistently regardless of whether the renderer is taking over a pre-existing PTY or a fresh one.

The `unregisterSerializer()` call is wired into `onDataDisposable.dispose` so the registration is torn down on pane unmount, regardless of which path registered it.

### Renderer pre-signal handshake

The cooperation gate (`ipc/pty.ts` skipping `seedHeadlessTerminal` when a renderer serializer is registered) has a fundamental timing problem on **fresh spawns**: the renderer cannot have registered the serializer for the new ptyId yet, because it doesn't know the ptyId until `pty:spawn` resolves. So at the moment the cooperation gate runs (immediately after `provider.spawn` returns inside `pty:spawn`'s handler), `runtime.hasRendererSerializerFor(ptyId) === false` for every fresh spawn — and the daemon-snapshot seed always wins, defeating the gate for the dominant case.

The renderer does, however, know its **paneKey** before spawn: every pane has a stable `ORCA_PANE_KEY` env var that is part of `args.env` on `pty:spawn`. We use the paneKey as a pre-signal, on a channel that doesn't depend on knowing the ptyId yet:

1. **Pre-signal IPC with generation token.** Renderer calls `pty:declarePendingPaneSerializer(paneKey)` BEFORE invoking `pty:spawn`. Main process maintains `pendingByPaneKey: Map<paneKey, generation: number>` keyed by paneKey. On each pre-signal, main mints a fresh monotonic `gen` value (incrementing a module-level `genSeq` counter) and overwrites the entry, then returns `gen` to the renderer. The renderer awaits this IPC (capturing `gen`), then awaits the spawn IPC — guaranteeing the main process has the pending intent recorded by the time `pty:spawn` runs.

   ```ts
   let genSeq = 0
   const pendingByPaneKey = new Map<string, number>()  // paneKey -> generation

   function declarePending(paneKey: string): number {
     const gen = ++genSeq
     pendingByPaneKey.set(paneKey, gen)
     return gen  // returned to renderer, echoed back on settle/clear
   }

   function settlePending(paneKey: string, gen: number): void {
     if (pendingByPaneKey.get(paneKey) === gen) pendingByPaneKey.delete(paneKey)
   }

   paneKeyTeardownListeners.add((paneKey, gen) => settlePending(paneKey, gen))
   ```

   Why a generation counter: today's design hooks `pendingByPaneKey.delete(paneKey)` into `clearProviderPtyState` via `paneKeyTeardownListeners`. If the OLD PTY's `clearProviderPtyState` fires AFTER mount-2's pre-signal but BEFORE mount-2's spawn, an unconditional teardown deletes mount-2's pending entry — defeating the gate. The generation counter solves this: the `paneKeyTeardownListeners` wiring captures the generation at the time the old PTY was REGISTERED (via the existing `registerPty` call site) and the teardown only fires `settlePending` with that generation. If mount-2 has already replaced the entry with a new gen, `pendingByPaneKey.get(K) !== oldGen` and the teardown is a no-op.

2. **Cooperation gate consults the pre-signal.** Inside `pty:spawn`, after `provider.spawn` returns, the gate becomes:
   ```ts
   const paneKey = args.env?.ORCA_PANE_KEY
   const rendererPreSignaled =
     typeof paneKey === 'string' && paneKey.length > 0 && paneKey.length <= 256
       && pendingByPaneKey.has(paneKey)
   const rendererAlreadyRegistered =
     runtime?.hasRendererSerializerFor?.(result.id) ?? false
   if (!rendererPreSignaled && !rendererAlreadyRegistered) {
     // No renderer is or will be authoritative for this PTY — daemon-snapshot
     // seed runs as today.
     runtime?.seedHeadlessTerminal(result.id, /* …snapshot/coldRestore… */)
   }
   ```
   The `rendererAlreadyRegistered` branch covers reattach, where the pane mounted before spawn returned and registration completed in the meantime. The `rendererPreSignaled` branch covers fresh spawn, where registration has not happened yet but is imminent. Note: the gate matches when `pendingByPaneKey.has(paneKey)` is true *regardless of generation*; the generation is only used by cleanup paths (teardown listeners, settle, clear) to prevent cross-generation deletion. **Invariant:** fresh-spawn always relies on the pre-signal branch (`hasRendererSerializerFor(ptyId)` is necessarily false at gate-time since the renderer hasn't received `ptyId` yet); the registered branch only fires for reattach where the pane mounted before spawn returned.

3. **Settle / clear (echo gen back).** After the spawn IPC resolves and the renderer calls `registerPtySerializer(ptyId, …)`, it calls `pty:settlePaneSerializer(paneKey, gen)` to remove the pending intent (echoing the `gen` value it captured from declarePending). The handler runs `settlePending(paneKey, gen)` which only deletes if the stored gen still matches. (The simpler "clear on first onPtyData" or "clear on receipt of `pty:registerPaneSerializer`" alternatives work too — the design picks the explicit `settle` IPC because it makes the contract auditable from the renderer side and avoids coupling main-process state to onPtyData flow.) On pane unmount or registration failure, the renderer also calls `pty:clearPendingPaneSerializer(paneKey, gen)` (sibling handler with the same `settlePending` semantics) to drop the pending intent.

**Sequence diagram (fresh spawn, happy path):**

```
Renderer                            Main / ipc-pty.ts                Runtime
  │                                       │                              │
  │ pty:declarePendingPaneSerializer      │                              │
  │ (paneKey) ───────────────────────────▶│ pendingByPaneKey.set(K, gen) │
  │ ◀──────────────────────── ack(gen) ──│                              │
  │                                       │                              │
  │ pty:spawn(args incl. ORCA_PANE_KEY) ─▶│                              │
  │                                       │ provider.spawn(...) → result │
  │                                       │ pendingByPaneKey.has(paneKey)│
  │                                       │   === true → SKIP            │
  │                                       │   seedHeadlessTerminal       │
  │                                       │                              │
  │ ◀──────────────────────────── ptyId ──│                              │
  │                                       │                              │
  │ registerPtySerializer(ptyId, fn)      │                              │
  │ pty:settlePaneSerializer(paneKey,     │                              │
  │   gen) ──────────────────────────────▶│ settlePending(paneKey, gen)  │
  │                                       │   if gen matches → delete    │
  │                                       │                              │
  │                                       │ first onPtyData(ptyId,data)──▶│
  │                                       │                              │ maybeHydrateFromRenderer
  │                                       │                              │ (headlessTerminals empty,
  │                                       │                              │  hasRendererSerializer true
  │                                       │                              │  → IPC round-trip → seed)
```

**Renderer-side call shape.** The renderer threads `gen` through every call site so cleanup (settle/clear) can be matched against the generation it captured at declare time:

```ts
// In pty-connection.ts startFreshSpawn / handleReattachResult:
const gen = await window.api.pty.declarePendingPaneSerializer(paneKey)
try {
  const ptyId = await window.api.pty.spawn(args)
  registerPaneSerializerFor(ptyId)
  await window.api.pty.settlePaneSerializer(paneKey, gen)
} catch (err) {
  await window.api.pty.clearPendingPaneSerializer(paneKey, gen)
  throw err
}
```

**Correctness properties:**

1. **Pre-signal arrives before `pty:spawn`.** The renderer awaits the pre-signal IPC, then awaits the spawn IPC. Electron `ipcRenderer.invoke`/`send` ordering on a single renderer is preserved on the main side, so the main process processes the pre-signal before `pty:spawn`'s handler runs.
2. **Missing paneKey degrades to today's behavior.** If `args.env?.ORCA_PANE_KEY` is absent (e.g., a pane that isn't yet wired to set it, an old renderer build, or a non-pane spawn path), the pre-signal lookup returns false, `rendererAlreadyRegistered` is also false on a fresh spawn, and the daemon-snapshot seed runs as today. No regression for callers that don't participate in the handshake.
3. **Pre-signal without settle (renderer crashes between spawn and registerPtySerializer).** The pending intent stays in the map, but it has no observable effect: the cooperation gate already ran, so the daemon snapshot was suppressed; the headless emulator stays empty; the first `onPtyData` falls through `hasRendererSerializer(ptyId) === false` and hydration's precondition leaves the state map absent. `trackHeadlessTerminalData` then lazy-creates the emulator and live writes populate it. We lose the daemon snapshot for this PTY in that narrow window — accepted limitation, since the renderer was clearly going to be authoritative but didn't make it. (To bound staleness, the entry in `pendingByPaneKey` is cleared whenever a paneKey teardown event fires via the existing `paneKeyTeardownListeners` registry, gated by the generation token.)

**Files-touched implications:** see "IPC contract changes" and "Files touched" — both `pty:declarePendingPaneSerializer` and `pty:settlePaneSerializer` need preload bindings AND main handlers.

### Status parity

Seeding the emulator bypasses `onPtyData`'s OSC-extraction path, so without intervention `leaf.lastAgentStatus` stays whatever it was (typically `null` for daemon-restored leaves) until the next live byte happens to carry an OSC title. Mobile would then see a stale or missing agent badge despite a rich seed.

A previous draft of this design called `extractLastOscTitle(rendered.data)` on the seed payload to recover the title. **That doesn't work**: xterm's `SerializeAddon.serialize()` writes out the visible buffer as a stream of cursor moves, SGR resets, and printable characters — it does NOT round-trip OSC 0/1/2 (window/icon title) escape sequences. The renderer xterm consumes the OSC and sets `terminal.options.title`, but the bytes never appear in `serialize()`'s output. So `extractLastOscTitle` on a seed payload is dead code — it always returns null even when the renderer's pane currently shows a perfectly good title. We need the title via a different channel.

**Approach: ship now via IPC widening, document as best-effort.** The renderer pane already wires `pane.terminal.onTitleChange` (in `pty-connection.ts`) to keep the tab title in sync. We capture the latest observed title in module state alongside the serializer registration, and widen the serialize-buffer IPC payload to carry it back to main:

1. **Renderer side** (`pty-buffer-serializer.ts`):
   - Module-level `lastTitleByPtyId: Map<ptyId, { title: string, owner: symbol, disposable: IDisposable }>` keyed by the same ownership-token symbol as `serializersByPtyId` (see "Renderer-side prerequisite"). Populated by a wrapper around `pane.terminal.onTitleChange` installed at the same time as `registerPtySerializer`. The entry stores BOTH the IDisposable returned from `pane.terminal.onTitleChange(...)` AND the owner symbol alongside the latest title.
   - When the pane unregisters, the `unregisterSerializer` closure disposes the IDisposable AND deletes the map entry, both gated by the owner-token match — same ownership semantics as the serializer map, so a StrictMode disposed first-mount cannot wipe the live second-mount's title or leak a dangling listener.
   - The IPC response payload widens from `{ data, cols, rows }` to `{ data, cols, rows, lastTitle?: string }`. Default omitted when no title was observed for this PTY (e.g., fresh shell pre-prompt).

2. **Main side** (`ipc/pty.ts`, `orca-runtime.ts`):
   - `requestSerializedBuffer` snapshot-shape validation accepts `lastTitle?: string`.
   - `RuntimePtyController.serializeBuffer(ptyId, opts?)` returns `Promise<{ data, cols, rows, lastTitle?: string } | null>`.
   - `maybeHydrateHeadlessFromRenderer` calls `applySeededAgentStatus(ptyId, rendered.lastTitle)` only when `rendered.lastTitle` is a non-empty string (the helper itself also short-circuits on null/empty for safety). The helper internally runs `detectAgentStatusFromTitle` and only writes `leaf.lastAgentStatus` when the result is one of `'idle' | 'working' | 'permission'`.

3. **`applySeededAgentStatus(ptyId, title)`** (new helper in `orca-runtime.ts`). Behavior:
   - If `title == null` or empty, no-op.
   - Look up the leaf for `ptyId` via the existing pty→leaf mapping. Run `detectAgentStatusFromTitle(rendered.lastTitle)` (the helper from `src/shared/agent-detection.ts`). If the result is non-null, set `leaf.lastAgentStatus = result`. If null (title is not a recognizable agent title), leave `lastAgentStatus` untouched — the next live OSC byte will populate it through the normal onPtyData path.
   - **MUST NOT** call `resolveTuiIdleWaiters(leaf)` or `deliverPendingMessages(leaf)`. The seeded status reflects the renderer's last-observed historical title, not a live transition; resolving idle waiters or delivering pending messages on stale data could mistakenly unblock orchestration callers that should only react to a fresh prompt-return.
   - **Why** (mandatory comment in the helper definition): `// seed-derived status reflects historical state; orchestration waiters must only react to live transitions to avoid resolving on stale data.`
   - **Rationale for routing through `detectAgentStatusFromTitle`:** we mirror the live path (`onPtyData` already uses `detectAgentStatusFromTitle`) so seeded and live paths produce the same union value, and downstream `leaf.lastAgentStatus === 'idle'` consumers (orchestration `tui-idle` waiters, pending-message gating) keep working. `leaf.lastAgentStatus` is typed `AgentStatus | null` where `AgentStatus = 'working' | 'idle' | 'permission'`; assigning the raw title string would be type-incorrect.

This delivers status parity for the dominant case via the `lastTitle` field (any pane that has rendered a prompt or had a TUI emit OSC titles will have populated `lastTitleByPtyId` long before mobile subscribes). Edge cases where the renderer never observed a title — fresh shell pre-prompt, pane that mounted but never received bytes — leave `lastAgentStatus` as `null`; that's acceptable since `lastAgentStatus` is documented best-effort and the next live OSC title will populate it through the normal `onPtyData` path.

**Status parity / accepted limitations.** Side effect of seeding `lastAgentStatus`: if the seed sets status to `'idle'`, the next live OSC byte that re-emits the same `'idle'` title will see `prevStatus === 'idle'` and the existing transition gate (`agentStatus === 'idle' && prevStatus !== 'idle'`) skips. Orchestration `tui-idle` waiters registered between seeding and the next idle transition will hang until either (a) a non-idle status arrives followed by another idle transition, or (b) the waiter times out. This is an accepted limitation. If it becomes a real problem, future work could split into `lastSeededAgentStatus` (informational, not gating) vs `lastAgentStatus` (gates transitions).

### Files touched

- `src/main/runtime/orca-runtime.ts` — add `headlessHydrationState`, `maybeHydrateHeadlessFromRenderer`, wire into `onPtyData` (with mandatory `// DO NOT REORDER` comment per "Ordering invariant"). Widen `RuntimePtyController.serializeBuffer?` to `(ptyId, opts?) => Promise<{ data, cols, rows, lastTitle?: string } | null>` and add `hasRendererSerializer?(ptyId)`. Add `applySeededAgentStatus(ptyId, title)` helper that writes `leaf.lastAgentStatus` only — must NOT call `resolveTuiIdleWaiters` or `deliverPendingMessages` (mandatory "Why" comment in the helper definition). Add `hasRendererSerializerFor(ptyId)` runtime-service-level method that delegates to `ptyController.hasRendererSerializer` (consumed by `ipc/pty.ts`'s cooperation gate). Forward `scrollbackRows` from `serializeTerminalBufferFromAvailableState` into the renderer-fallback call (do NOT pass `altScreenForcesZeroRows: true` on this path — see "alt-screen flag scoping").
- `src/main/ipc/pty.ts` — `requestSerializedBuffer(ptyId, opts?)` accepts opts and forwards them on the `pty:serializeBuffer:request` IPC payload. Wire `hasRendererSerializer` through a renderer-registry getter. **Cooperate with hydration:** when a renderer serializer is registered for the spawning PTY *or* the renderer pre-signaled intent for `args.env.ORCA_PANE_KEY`, skip seeding from `result.snapshot` / `result.coldRestore.scrollback` so the daemon's bare-prompt state cannot pre-empt the richer renderer hydration that follows on first byte. **Add three new IPC handlers** with consistent paneKey validation (`typeof paneKey === 'string' && paneKey.length > 0 && paneKey.length <= 256` — invalid input is rejected before mutating state): `pty:declarePendingPaneSerializer(paneKey): Promise<number>` (renderer → main, before `pty:spawn`) mints a fresh generation `gen`, stores `pendingByPaneKey.set(paneKey, gen)` in a module-level `pendingByPaneKey: Map<string, number>`, and returns `gen` to the renderer; `pty:settlePaneSerializer(paneKey, gen)` (renderer → main, after `registerPtySerializer`) runs `settlePending(paneKey, gen)` which deletes only if the stored gen still matches; `pty:clearPendingPaneSerializer(paneKey, gen)` (renderer → main, on spawn-rejection / unmount-before-settle) has the same `settlePending` semantics. Hook `paneKeyTeardownListeners.add((paneKey, gen) => settlePending(paneKey, gen))` so a torn-down PTY's listener captures the generation it was registered under and only clears the map when that generation still matches — ensuring a teardown for the OLD PTY cannot delete a NEW PTY's pending intent if mount-2's pre-signal landed in between. (See "Renderer pre-signal handshake" and "Cooperation with seedHeadlessTerminal" in Open questions.)
- `src/preload/index.ts` — extend the `pty:serializeBuffer:request` listener payload type to include `opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }`. Add three new bindings under `pty`: `declarePendingPaneSerializer(paneKey: string): Promise<number>` (returns the `gen` token), `settlePaneSerializer(paneKey: string, gen: number): Promise<void>`, and `clearPendingPaneSerializer(paneKey: string, gen: number): Promise<void>`, all forwarded as `ipcRenderer.invoke('pty:declarePendingPaneSerializer', …)` / `'pty:settlePaneSerializer'` / `'pty:clearPendingPaneSerializer'` so the renderer can `await` them and rely on main-side ordering before issuing `pty:spawn` / after `registerPtySerializer`. The renderer captures `gen` from declare and threads it through every settle/clear call.
- `src/renderer/src/components/terminal-pane/pty-buffer-serializer.ts` — widen `SerializeFn` to `(opts?) => Promise<{ data, cols, rows, lastTitle?: string } | null> | …`; default to today's full-buffer behavior when opts is absent. Convert `serializersByPtyId: Map<ptyId, SerializeFn>` to `Map<ptyId, { fn: SerializeFn, owner: symbol }>` and have `registerPtySerializer` mint a fresh owner symbol per call, returning an unregister closure that deletes only when `current?.owner === thisOwner` (StrictMode safety — see "Renderer-side prerequisite"). Add a parallel `lastTitleByPtyId: Map<ptyId, { title: string, owner: symbol, disposable: IDisposable }>` populated by a wrapper around `pane.terminal.onTitleChange`, with the unregister closure both disposing the IDisposable AND deleting the entry under the same owner-token check. The serialize listener reads from `lastTitleByPtyId` to populate `lastTitle` in the IPC response.
- `src/renderer/src/components/terminal-pane/pty-connection.ts` — register the serializer for **fresh spawns** as well as reattach. Extract the registration body into a shared `registerPaneSerializerFor(ptyId)` helper called from both `handleReattachResult` AND the post-spawn callback in `startFreshSpawn`. Thread opts (scrollback cap, alt-screen flag) into `pane.serializeAddon.serialize`. Add `if (disposed) return` guard at the top of every post-spawn registration call (StrictMode safety — see "Renderer-side prerequisite"). Track the latest `pane.terminal.onTitleChange` value in module state alongside the serializer registration so the serializer's IPC response can include `lastTitle` (see "Status parity"). Call `const gen = await window.api.pty.declarePendingPaneSerializer(paneKey)` BEFORE `pty:spawn` on every fresh-spawn path (capturing the returned generation token), and `settlePaneSerializer(paneKey, gen)` AFTER `registerPaneSerializerFor(ptyId)` succeeds. On spawn-rejection (catch-arm) AND on pane unmount AFTER pre-signal but BEFORE settle, call `clearPendingPaneSerializer(paneKey, gen)` — this is mandatory (see "Renderer-side prerequisite" item 3). Unregister on pane unmount via the existing `onDataDisposable.dispose` hook (now using the ownership-token contract from "Renderer-side prerequisite").
- `src/main/runtime/scrollback-limits.ts` (new) — main-process module exporting `MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000`. Imported by both `src/main/runtime/rpc/methods/terminal.ts` and `src/main/runtime/orca-runtime.ts`. (The constant is main-process-only; promoting it to `src/shared/` would expose a runtime cap to the renderer for no benefit.)
- `src/main/runtime/orca-runtime.test.ts` — add hydration unit tests (see "Test plan").
- `src/main/runtime/mobile-subscribe-integration.test.ts` — extend with cross-process hydration scenario.

No changes to:
- `pty:data` batching, daemon adapter.
- `serializeTerminalBufferFromAvailableState` priority order (headless still primary; renderer still no-headless fallback).
- Mobile RPC method signatures (`terminal.subscribe`, `terminal.resizeForClient`).
- Mobile WebView / `TerminalWebView.tsx`.
- Persistence (`HistoryManager`, `checkpoint.json` shape).

## Why this is structurally sound

The renderer xterm is, in practice, the fuller and more authoritative state for any mounted pane:

1. **It hydrates on attach.** `pty-connection.ts` calls `replayIntoTerminal(pane, …, coldRestore.scrollback)` and writes `snapshot` immediately after pane mount. The headless emulator never replays either. So even on a session that started before the current Orca run, the renderer xterm contains the full history; the headless emulator does not.

2. **It has a bigger buffer.** 50,000 rows vs 5,000.

3. **It is updated on the same IPC tick as the visible UI.** No staleness vs what the user sees.

Hydrating the headless emulator from the renderer on first runtime touch is the same shape of operation as the existing `seedHeadlessTerminal(provider.spawn snapshot)` path. We are not introducing a new architectural pattern; we are extending an existing one to the case where the daemon snapshot is empty but the renderer is rich. The runtime remains authoritative for everything mobile, CLI, `terminal.read`, and `lastAgentStatus` see — the renderer is consulted exactly once per `(ptyId, runtime)` pair.

This is a structural-adjacent improvement that fixes the dominant case (user has both desktop and mobile open) while consciously deferring Scenario A (mobile-only after relaunch) to a separate daemon-persistence design. It is honest about what it does and does not solve.

## Data flow paths

### Happy path — renderer mounted, hydration succeeds

```
T0  user opens desktop pane.
    - Fresh spawn: pty-connection.ts calls
      const gen = await pty:declarePendingPaneSerializer(paneKey)
      BEFORE pty:spawn, then awaits both. Main mints a fresh gen and
      records the pending intent under it. After spawn resolves with
      ptyId, registerPaneSerializerFor(ptyId) +
      pty:settlePaneSerializer(paneKey, gen) clear the intent (only if
      the stored gen still matches). On spawn-rejection or unmount-
      before-settle, pty:clearPendingPaneSerializer(paneKey, gen) runs
      instead (mandatory — see "Renderer-side prerequisite" item 3).
    - Reattach: registerPaneSerializerFor(ptyId) runs in
      handleReattachResult once the ptyId is known.
    Either way, ipc/pty.ts's cooperation gate sees that the renderer
    is or will be authoritative for this PTY (via either
    hasRendererSerializerFor(ptyId) === true OR a pre-signaled paneKey)
    and SKIPS the daemon-snapshot seedHeadlessTerminal call.
T1  PTY emits live byte → ipc/pty.ts forwards to renderer (xterm grows)
                       → ipc/pty.ts forwards to runtime.onPtyData
T2  onPtyData: maybeHydrateHeadlessFromRenderer
      - hasRendererSerializer(ptyId) === true → state: absent → pending
      - serialize round-trip with opts {scrollbackRows, altScreenForcesZeroRows}
      - on resolve: HeadlessEmulator built at rendered.cols/rows,
        applySeededAgentStatus(ptyId, rendered.lastTitle), write(rendered.data)
      - resize emulator to PTY dims if they diverge from rendered dims
T3  trackHeadlessTerminalData(data) chains AFTER the seed via writeChain,
    so the live byte is appended on top of the seeded buffer — order
    preserved.
T4  hydration state → done. Subsequent onPtyData calls skip the guard.
T5  user opens mobile → terminal.subscribe → serializeHeadless returns
    seeded buffer + everything since. Mobile == desktop, and
    leaf.lastAgentStatus is populated from rendered.lastTitle
    (sourced from pane.terminal.onTitleChange, NOT from the seed payload —
    SerializeAddon does not round-trip OSC titles).
```

### Nil path — Scenario A: no renderer ever mounts

```
T0  user relaunches Orca, opens mobile only.
T1  ipc/pty.ts: provider.spawn returns coldRestore.scrollback = ""
    (daemon checkpoint had scrollbackAnsi: "" — visible screen only)
    or a thin visible-screen snapshot. hasRendererSerializerFor(ptyId)
    is false (no pane mounted), so the cooperation gate does NOT skip:
    seedHeadlessTerminal runs as today.
T2  PTY emits live byte → onPtyData → maybeHydrateHeadlessFromRenderer
      - hasRendererSerializer(ptyId) is false → state map left absent.
        (Pane could still mount later in this runtime; we'd retry then.)
T3  trackHeadlessTerminalData populates from live bytes; emulator
    already contains the daemon-snapshot seed.
T4  Mobile sees daemon's visible-screen snapshot + live bytes since.
    KNOWN LIMITATION; out of scope for this design.
```

### Error path — renderer throws or unmounts mid-hydration

```
T0–T1  same as happy path through `pending` state.
T2     ptyController.serializeBuffer rejects (renderer disposed,
       channel closed, IPC timeout, etc.).
       - catch swallows the error.
       - hydration state → done (we do not loop on every byte).
T3     Live bytes continue to populate the emulator via
       trackHeadlessTerminalData (which lazily creates the headless
       state at PTY dims). We lose the seed for this runtime but do
       not block live data flow.
```

The "advance to done on serialize failure" rule is intentional. Re-trying on every subsequent byte would create a renderer round-trip on every byte until success — too costly for a best-effort path. The "leave state absent when the renderer isn't ready yet" rule (the precondition checks before `pending`) is the inverse trade-off: those checks are cheap (Map lookups), so retrying them is fine.

### SSH note

SSH-backed PTYs flow through the same `runtime.onPtyData` entry point as local and daemon-backed PTYs (see `ipc/pty.ts` provider listener — all providers call `runtime.onPtyData(id, data, at)` uniformly). Hydration applies to SSH PTYs without special-casing: when a desktop pane is mounted on an SSH-backed terminal, its `registerPtySerializer` registration is identical to the local case, and the runtime sees `hasRendererSerializer(ptyId) === true` regardless of provider. The mobile + SSH + relaunch case (rare in practice) inherits Scenario A's known-limitation behavior.

### Concurrent path — live data arrives during hydration

The renderer round-trip is asynchronous; live `pty:data` will continue to arrive before `serializeBuffer` resolves. The pattern from `seedHeadlessTerminal` already handles this: every emulator write is appended to `state.writeChain`, so:

```
writeChain: Promise.resolve()
          → seed write       ← scheduled by maybeHydrateHeadlessFromRenderer
          → live byte 1      ← scheduled by trackHeadlessTerminalData
          → live byte 2
          → live byte N
```

`emulator.write` is invoked in chain order, preserving the byte sequence exactly as the wire delivered it. The seed always lands before the live bytes that triggered hydration, because the trigger logic schedules the seed write *before* it returns control to `onPtyData`, which then schedules the live write.

## Performance

`ptyController.serializeBuffer(ptyId)` does an IPC round-trip to the renderer where xterm's SerializeAddon runs synchronously over the buffer. Cost is roughly proportional to scrollback size: empirically ~50–200 ms for a full 50k-row buffer.

The cost profile is materially different from the rejected priority-flip approach:

| Approach | Renderer round-trip frequency |
|---|---|
| Priority flip (rejected) | Once per `terminal.subscribe` AND `terminal.resizeForClient` |
| Hydrate-on-first-touch (this) | Once per `(ptyId, runtime)` pair, ever |

For a typical session — Orca starts, user opens desktop pane, agent runs for hours, user opens mobile periodically — this approach pays the IPC cost exactly once *for hydration* per `(ptyId, runtime)` pair. The existing renderer-fallback inside `serializeTerminalBufferFromAvailableState` is preserved — it can still hit the renderer on `terminal.read` / `terminal.subscribe` when the headless emulator returns null — but that path is the read-time fallback, not the hydration path. The priority-flip approach paid the IPC cost on every mobile re-subscribe (foreground/background, navigation between worktrees, phone-fit toggle). The "first byte after pane mount" trigger ties the hydration cost to a moment that is already doing IO work, so the latency is hidden inside the existing flow.

There is no per-keystroke cost; `trackHeadlessTerminalData` is unchanged.

## Reflow asymmetry

Hydration happens at whatever cols the renderer is currently at — typically the desktop's natural size (e.g., 105 cols). When mobile later subscribes and triggers a 49-col phone-fit resize, the headless emulator (now seeded with 105-col data) reflows to 49 cols just like the renderer would. Both buffers reflow from the same starting content, so they stay in sync.

This is a real improvement over the priority-flip proposal, which was sensitive to the order in which renderer and headless reflow completed across the IPC tick boundary. With hydrate-on-mount the seed has already landed before any phone-fit resize is even requested, so the reflow asymmetry concerns largely go away: at subscribe time both buffers contain the same content and respond to the same resize event in the same `handleMobileSubscribe` synchronous block.

## Risks

1. **Live data arrives during pending hydration.** Mitigated by chaining through `state.writeChain`, exactly as `seedHeadlessTerminal` already does. Order is preserved.

2. **Renderer pane unmount mid-round-trip.** Caught by `try/catch`; the guard advances to `done` so we don't loop on every subsequent byte, and live writes continue via lazy emulator creation in `trackHeadlessTerminalData`. We lose the seed for that PTY, which is acceptable given how rare unmount-during-IPC is.

3. **Wire-payload size on hydration.** Capped at 1000 rows from day one via the shared `MOBILE_SUBSCRIBE_SCROLLBACK_ROWS` constant. Alt-screen forces 0 rows. This matches the existing serialize path's behavior, so users see identical depth from both sources. The headless emulator's own 5,000-row `DEFAULT_SCROLLBACK` (in `HeadlessEmulator`) is comfortably above the 1k hydration cap; if a future change raises the hydration cap, `HeadlessEmulator`'s default must be bumped in lockstep or the seed will be silently truncated as it lands in the emulator.

4. **Renderer xterm is *behind* the runtime.** Theoretically possible if `pty:data` is delivered to the runtime before the renderer (depends on dispatch order in `ipc/pty.ts`). The renderer's xterm uses an asynchronous `write(callback)`, so even when bytes are delivered the buffer may not yet contain them. In practice this is sub-millisecond and the seed will be at most one frame behind the live byte that triggered it — better than today's headless-only path which has none of those bytes.

5. **Hydration races registerPty.** If `onPtyData` fires before `runtime.registerPty` has been called for this PTY, `getTerminalSize` may return null and we default to 80×24 for the post-seed PTY dims. The seed itself is constructed at the renderer's reported dims (see Pseudocode), so xterm reflow only happens on the post-seed `resize` call — at most one reflow, and only when PTY and renderer dims actually diverge.

6. **PTY-size vs renderer-dim divergence (resize-after-seed reflow).** Under mobile-fit overrides, or in the brief window before a `pty:resize` lands on the main process, the renderer's xterm dims and the runtime's `ptySizes` entry can disagree. Constructing the headless emulator at PTY-size and then writing a seed captured at renderer-dim would force xterm to wrap/reflow the seed in the wrong column count — visible as broken line breaks or doubled prompts. Mitigation: build the emulator at `rendered.cols / rendered.rows`, then resize to PTY-size after the seed lands. See Pseudocode. **At extreme size deltas (e.g., 105→32), the seed-then-reflow path can produce minor visible divergence vs the renderer's own reflow** (xterm reflow is not strictly invertible across very different widths, and the headless emulator runs the reflow on already-laid-out cells rather than the original byte stream). This is an accepted limitation, not a correctness issue: the reflow result is still valid xterm output, just potentially line-broken slightly differently than what the desktop pane shows for the same scrollback. Mobile users have always seen a phone-fit reflow distinct from desktop's; this design does not change that.

7. **Note: writes are flushed before serialize.** The renderer-side serializer (`pty-buffer-serializer.ts:registerPtySerializer`) flushes `pendingWritesRef` via `replayIntoTerminalAsync` before calling `pane.serializeAddon.serialize()`, so the seed faithfully includes hidden-pane buffered writes. No additional sequencing logic is needed in the runtime.

8. **`pendingWritesRef` double-write window (severity-adjusted P2).** When a pane is hidden at the moment bytes arrive, the renderer-side `pendingWritesRef` buffers them while `runtime.onPtyData` simultaneously routes the same bytes into the headless emulator via `trackHeadlessTerminalData`. The renderer's serializer flushes `pendingWritesRef` before serializing, so the seed payload includes those bytes. If hydration runs after `trackHeadlessTerminalData` has already written the same bytes, the headless emulator ends up with a duplicated stretch.

   **Mitigation: the P0-A2 pre-signal handshake makes this rare in practice.** With pre-signal, hydration is the FIRST writer for a fresh-spawn-with-pre-signal — `trackHeadlessTerminalData`'s lazy-create check sees the emulator already exists (created at hydration time) and just appends, so live bytes between seed-fetch and seed-resolve are queued behind the seed via `state.writeChain`. The double-write only manifests in the narrow combo of: (a) reattach path, (b) hidden pane buffering live bytes into `pendingWritesRef`, AND (c) hydration runs after `trackHeadlessTerminalData` has already populated the headless emulator. The impact is bounded: at most one ~8 ms PTY-batch's worth of bytes can be duplicated, the duplicate is visible only in mobile/CLI scrollback (desktop renders from its own xterm which never duplicates), and a future shell prompt overwrites the area anyway. Document as a known limitation; not a correctness-blocking issue. If it becomes user-visible, the fix is to track a per-pty "live bytes seen since last serialize request" cursor on the renderer and trim the seed payload to bytes the renderer observed before hydration started — out of scope for this design.

## Test plan

### Unit (`orca-runtime.test.ts`)

- Hydration runs on the *first* `onPtyData` for a `ptyId` when `hasRendererSerializer` is true and `serializeBuffer` returns non-empty data. Assert the emulator's serialized output contains both the seeded prefix and the live byte.
- Subsequent `onPtyData` calls do **not** re-trigger hydration after a successful run. Mock `serializeBuffer` and assert it was called exactly once across N `onPtyData` invocations for the same ptyId.
- "Exactly once" claim is qualified: the renderer round-trip happens once per `(ptyId, runtime)` for hydration. The existing `serializeTerminalBufferFromAvailableState` renderer-fallback (consulted only when the headless emulator returns null) is preserved and may still hit the renderer on `terminal.read` / `terminal.subscribe` paths.
- When `ptyController` is null (CLI / headless test runs), hydration leaves the state map untouched, headless emulator is created lazily as today, no IPC attempt.
- When `hasRendererSerializer(ptyId)` returns false on the first byte but true on a later byte, hydration **does** run on the later byte (state is left absent on idle, not consumed). Confirms the contract change for Open Question P2-2.
- When `ptyController.serializeBuffer` rejects, the guard advances to `done` (no infinite retry), the emulator is created lazily by `trackHeadlessTerminalData`, live bytes still write through.
- Live data arriving during pending hydration is queued behind the seed write. Schedule the seed-write as a long pending promise, fire several `onPtyData` calls, await `writeChain`, assert the final emulator content has the seed prefix followed by the live bytes in correct order.
- The 1000-row cap is applied to the renderer-sourced hydration: mock `serializeBuffer` to return a payload representing >1000 rows, assert the requested option bag includes `scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS`.
- Alt-screen flag is forwarded: assert the request includes `altScreenForcesZeroRows: true`. (The alt-screen branch is exercised in renderer-side serializer tests where it has access to a real xterm `buffer.active.type`.)
- **Status parity (lastTitle field):** mock `serializeBuffer` to return `{ data, cols, rows, lastTitle }` where `lastTitle` is a recognizable agent title. Fire `onPtyData`. Assert `leaf.lastAgentStatus` is one of `'idle' | 'working' | 'permission'` (whatever `detectAgentStatusFromTitle` returns for that title) after hydration and before any live OSC title bytes are observed. Conversely, when `lastTitle` is absent / undefined OR `detectAgentStatusFromTitle(lastTitle)` returns `null` (unrecognizable title), assert `leaf.lastAgentStatus` is left unchanged from its prior value (no overwrite).
- **Multi-PTY concurrent hydration:** fire `onPtyData` for ptyA and ptyB before either `serializeBuffer` resolves. Assert each PTY's hydration completes with its own payload (no cross-talk through the IPC response listener pool — each request has a unique `requestId`).
- **Re-entrant `onPtyData`:** when `agentDetector.onData` synchronously triggers another `onPtyData` for the same ptyId (or a different ptyId), confirm the hydration state machine still holds — no double-pending, no skipped seed, no out-of-order emulator writes.
- **Cooperation with `seedHeadlessTerminal`:** when a renderer serializer is registered for `ptyId`, the spawn-time call from `ipc/pty.ts` skips seeding (no daemon-snapshot bytes written to the emulator). When no serializer is registered, the daemon-snapshot path runs as today.
- **Fresh-spawn timing race (P0-A2 pre-signal handshake):** simulate the renderer pre-signaling intent for paneKey via `const gen = await pty:declarePendingPaneSerializer(paneKey)`, then call the `pty:spawn` handler with `args.env.ORCA_PANE_KEY === paneKey`. Assert `seedHeadlessTerminal` is **NOT** invoked even though `hasRendererSerializerFor(result.id)` is false at that moment (the renderer hasn't received the ptyId yet). The renderer mock then `registerPtySerializer(ptyId, …)` and `pty:settlePaneSerializer(paneKey, gen)`. Fire `onPtyData(ptyId, liveByte)`. Assert `maybeHydrateHeadlessFromRenderer` runs and the headless emulator is populated from the renderer's serialize payload, with the live byte appended after the seed via `writeChain`.
- **Pre-signal without settle (renderer crash):** simulate `pty:declarePendingPaneSerializer(paneKey)` followed by `pty:spawn` (gate skips daemon seed) but the renderer never calls `registerPtySerializer` or `settlePaneSerializer`. Fire `onPtyData`. Assert hydration's preconditions leave the state map absent, `trackHeadlessTerminalData` lazy-creates the emulator, and live bytes populate it. The pending-paneKey entry is dropped on the next paneKey teardown event.
- **Pre-signal preserved across paneKey reuse during teardown:** simulate (a) old PTY for paneKey K is exiting, its `paneKeyTeardownListener` is queued (captured at registration time with `gen1`). (b) Mount-2 calls `pty:declarePendingPaneSerializer(K)` and stores generation `gen2` (`gen2 > gen1`). (c) The queued teardown for the old PTY runs; the listener invokes `settlePending(K, gen1)` and SKIPS the delete because `pendingByPaneKey.get(K) === gen2`. (d) Mount-2 calls `pty:spawn`; the cooperation gate matches (`pendingByPaneKey.has(K) === true`) and seed is suppressed. Assert daemon-snapshot seed did NOT run.
- **Test imports for `scrollback-limits.ts`:** tests in `orca-runtime.test.ts` and `mobile-subscribe-integration.test.ts` import `MOBILE_SUBSCRIBE_SCROLLBACK_ROWS` from `../scrollback-limits` so cap-assertion lines match the production constant (no hardcoded `1000`).
- **Status parity (real `SerializeAddon` round-trip):** in a renderer-side unit test (using a real `xterm` `Terminal` + `SerializeAddon`), write OSC 0/1/2 title bytes (e.g., `\x1b]0;some-title\x07`) into the terminal, await the `onTitleChange` listener, then call `serializeAddon.serialize()`. **Assert the serialize output does NOT contain the OSC title bytes** — this codifies the limitation that motivated the `lastTitle` field. Then, in a runtime-side unit test, mock the renderer-IPC response to include `{ data, cols, rows, lastTitle }` where `lastTitle` is a known agent title, fire `onPtyData`, and assert `applySeededAgentStatus` was called with that title and `leaf.lastAgentStatus` is the corresponding `'idle' | 'working' | 'permission'` value returned by `detectAgentStatusFromTitle` afterward.
- **`applySeededAgentStatus` does not resolve waiters:** with a leaf that has pending TUI-idle waiters and pending orchestration messages registered, call `applySeededAgentStatus(ptyId, title)` where `title` is a recognizable agent title. Assert `leaf.lastAgentStatus` matches `detectAgentStatusFromTitle(title)` (one of `'idle' | 'working' | 'permission'`), AND assert `resolveTuiIdleWaiters` and `deliverPendingMessages` were **NOT** invoked. (Spy on the methods or assert the waiter / pending-message queues are unchanged.) This guards against future drift where a refactor lifts shared logic between the live and seeded paths.

### Integration (`mobile-subscribe-integration.test.ts`)

- Cross-process scenario with a mocked renderer that registers a richer scrollback than the headless adapter would produce. After the runtime sees its first live byte, mobile subscribes; assert the `scrollback` frame's `serialized` field includes the seeded prefix.
- Scenario A regression guard: no renderer registered, mobile subscribes, assert mobile receives only what the daemon snapshot + live bytes provide, hydration was never invoked. (Documents the known limitation.)

### Manual

On a real device, reproduce the original `edit-issues` post-claude-exit scenario, confirm the mobile WebView now shows the same agent summary the desktop shows.

## Open questions

- **Hydration trigger point.** Three plausible options: (a) first `onPtyData`, (b) `runtime.registerPty`, (c) an explicit renderer-pane-mount notification from the renderer. (a) is the chosen approach: cheap, ties cost to a moment already paying IO, and **retryable within a runtime**. The state map is left absent (not `done` or `skipped`) when the renderer serializer isn't yet registered, so a later byte can attempt hydration once the pane mounts. The only consume-on-idle case is `headlessTerminals.has(ptyId)` (live bytes already arrived), where re-seeding would duplicate. (b) fires before the renderer has any data to serialize. (c) needs a new wire from `pty-connection.ts → ipc/pty.ts → runtime`.

- **Cooperation with `seedHeadlessTerminal`.** Today `seedHeadlessTerminal` writes to the headless emulator on `provider.spawn` from `result.snapshot` / `result.coldRestore.scrollback`. The daemon's `result.snapshot` is the visible-screen-only ANSI from `checkpoint.json` — almost always non-empty (it includes the bare prompt) but typically much thinner than what the renderer pane has. If both fire for the same PTY, the daemon path lands first and `headlessTerminals.has(ptyId)` becomes true; the hydration guard would then mark itself `done` and the richer renderer payload is lost. **Decision: gate `seedHeadlessTerminal` on (a) an already-registered renderer serializer OR (b) a renderer pre-signal for the spawning PTY's paneKey.** In `ipc/pty.ts`, before calling `runtime.seedHeadlessTerminal(...)`, check both `runtime.hasRendererSerializerFor(result.id)` AND `pendingByPaneKey.has(args.env?.ORCA_PANE_KEY)` (after validating the paneKey shape — see P1-B2 in the cooperation gate snippet). If either is true, skip the daemon-snapshot seed entirely and let renderer hydration be canonical. (a) covers reattach, where the pane mounted before spawn returned. (b) covers fresh spawn, where the renderer pre-signaled intent before `pty:spawn` but cannot have registered yet because it doesn't know the ptyId. If neither is true (Scenario A — mobile-only, no desktop pane), the daemon-snapshot path runs unchanged. See "Renderer pre-signal handshake" for the full sequence and correctness properties. This is cleaner than a length-comparison "richness heuristic" and lets the renderer be authoritative whenever it's mounted *or* about to mount.

## Rollout

Single change touching the runtime and the renderer-side serialize controller. No feature flag — the hydration is best-effort and degrades to today's behavior when the renderer cannot answer or has nothing useful to share.

Ready for implementation review. Scenario A remains a known limitation tracked for a future daemon-persistence design.
