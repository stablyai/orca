# Split-Pane CWD Inheritance (Cmd+D / Cmd+Shift+D)

## Problem

When the user presses **Cmd+D** or **Cmd+Shift+D** to split a terminal pane, the new pane spawns at the worktree root instead of the source pane's current working directory. Most visible on **SSH** workspaces, but true locally as well — local only appears to "work" when the user hasn't `cd`'d away from the worktree root.

Reference point: Ghostty, iTerm2, kitty, Warp, and WezTerm all inherit the source pane's live CWD when splitting.

## Current behavior (code-level trace)

1. `src/renderer/src/components/terminal-pane/keyboard-handlers.ts:283` dispatches on `action.type === 'splitActivePane'`; the `manager.splitPane(pane.id, direction)` call is at `:296`.
2. `src/renderer/src/lib/pane-manager/pane-manager.ts:93 splitPane()` creates the new pane and fires `onPaneCreated(newPane)`.
3. `src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts:349 onPaneCreated` → `connectPanePty(pane, manager, {...ptyDeps})`.
4. `src/renderer/src/components/terminal-pane/pty-connection.ts:272` builds the transport with `cwd: deps.cwd`.
5. `deps.cwd` is set once per tab at mount from the `TerminalPane` prop, always `worktree.path`.

There is **no plumbing** anywhere in the renderer that (a) tracks the live CWD of a pane or (b) threads a per-split CWD override into `splitPane`.

The renderer does not currently register any OSC-7 handler. Only the headless daemon emulator (`src/main/daemon/headless-emulator.ts`) parses OSC-7 — that path only feeds daemon snapshot metadata, never the renderer's pane state.

## Prior art: Superset

Superset (sibling project at `../../superset`) already implements renderer-side OSC-7 tracking:

- `parseCwd.ts` — regex `ESC]7;file://[^/]*(/...)BEL|ST`, URI-decodes the path, returns the most recent match in a data chunk.
- `useTerminalCwd.ts` — per-pane hook: seeds from `initialCwd`/`workspaceCwd`, calls `parseCwd` on every xterm data event, stores `{terminalCwd, cwdConfirmed}` with a 150ms debounce.

Superset's split action accepts `options.initialCwd` but its Cmd+D wiring passes a **preset** CWD, not the source pane's tracked `terminalCwd`. We will close that loop.

## Design

### Overview

Track each pane's live CWD in the renderer via OSC-7, fall back to a one-shot `pty.getCwd` query, and pass the resolved value as `cwd` when spawning the new split PTY.

### 1. Track per-pane CWD via OSC-7

Add an OSC-7 handler alongside the existing OSC-52 handler in `use-terminal-pane-lifecycle.ts` `onPaneCreated` (near line 369):

```ts
const osc7Disposable = pane.terminal.parser.registerOscHandler(7, (data) => {
  const cwd = parseOsc7(data)
  if (cwd) {
    paneCwdRef.current.set(pane.id, cwd)
  }
  // Return true so xterm marks the sequence handled and does not fall
  // through to any builtin behavior. Note: xterm's `registerOscHandler`
  // contract is "first handler that returns true wins"; if a future
  // consumer (e.g. a shared daemon emulator path) also registers on
  // code 7, registration order decides who sees each sequence.
  return true
})
```

- New ref on `TerminalPane`: `paneCwdRef = useRef<Map<number, string>>(new Map())`.
- Disposable tracked in an `osc7DisposablesRef` map parallel to `osc52DisposablesRef`, torn down in `onPaneClosed` (see `use-terminal-pane-lifecycle.ts:481-484` for the OSC-52 pattern). `onPaneClosed` must also `paneCwdRef.current.delete(paneId)` so the map doesn't accumulate dead entries across splits/closes.
- **Why `registerOscHandler(7)` rather than scanning raw data:** xterm's OSC parser handles BEL/ST termination, sequence fragmentation across chunks, and nesting. A regex on raw data (as Superset does) misses sequences split across PTY read boundaries.
- **Handler install must stay before PTY attach.** The current `onPaneCreated` body (`use-terminal-pane-lifecycle.ts:349-460`) installs OSC parser handlers synchronously *before* `connectPanePty`. That ordering is load-bearing: it guarantees the first byte of the PTY stream — which in the cold-restore path is replayed scrollback containing OSC-7 — reaches our handler. Add a `// Why:` comment so a future refactor does not move the install after attach.
- **Replay + stale OSC-7.** Replayed scrollback can contain OSC-7 from an earlier `cd` that no longer reflects the live shell cwd. `paneCwdRef` does not distinguish replayed vs. live entries. Store `{cwd, confirmed: boolean}` and mark `confirmed = false` when `isPaneReplaying(...)` is true at handler fire time, `confirmed = true` otherwise. `resolveSplitCwd` prefers a `confirmed` entry and otherwise falls through to `pty.getCwd`, which reflects live shell state via `/proc` or `lsof`. **Why the flag is reliable during replay:** `replayIntoTerminal` (`replay-guard.ts:37-55`) increments the counter *before* `pane.terminal.write(data, cb)` and decrements it inside xterm's write-completion callback. xterm fires parser handlers synchronously as it consumes the buffer, so every OSC-7 parsed out of the replayed chunk sees a non-zero counter. Do **not** change `replay-guard.ts` to a pre-`write` decrement — the whole design depends on the decrement being post-parse.

No debouncing needed — `Map.set` is cheap and the value is read only on demand at split time.

### 2. Resolve CWD at split time

Introduce a helper `resolveSplitCwd(sourcePaneId, sourcePtyId, fallbackCwd): Promise<string>`. Owned by `use-terminal-pane-lifecycle.ts` (co-located with `paneCwdRef`) and passed down to keyboard and context-menu handlers as a dep, symmetric with the existing `paneTransportsRef` wiring.

1. If `paneCwdRef.current.get(sourcePaneId)` has `confirmed === true`, return its `cwd` **synchronously** (no await). OSC-7 from a live shell is authoritative and instant.
2. Otherwise `await window.api.pty.getCwd(sourcePtyId)` with a ~200ms soft timeout enforced renderer-side via `Promise.race` — keeps the "fall through to fallback" semantics in one place rather than threading timeouts into the provider. Use the result if non-empty.
3. Otherwise, if `paneCwdRef.current.get(sourcePaneId)` has `confirmed === false` (replayed OSC-7 only), return its `cwd` as a last-ditch guess before falling back.
4. Otherwise return `fallbackCwd` (the existing worktree root).

**Sync vs async in the keydown handler.** The current Cmd+D handler at `keyboard-handlers.ts:283` is synchronous and calls `e.preventDefault()` / `e.stopImmediatePropagation()` before `splitPane`. The new flow preserves sync ordering:

- Compute `preventDefault` + pane snapshot synchronously.
- Read `paneCwdRef` synchronously. If hit → call `splitPane` immediately (no `await`).
- If miss → fire-and-forget an `async` IIFE that awaits `pty.getCwd` then calls `splitPane`. This is equivalent to today's async pane-creation lifecycle, which is already non-blocking.

Double Cmd+D in the cache-miss window: the second keypress fires before the first fire-and-forget IIFE has called `splitPane`, so both async callbacks still see the original source pane as active, resolve the same `pty.getCwd`, and produce two splits off that source (not a chain). This differs from today's fully-sync behavior, which would have chained the second split off the just-created pane. Accepted tradeoff — the window is ~1 IPC round-trip (≤200 ms) and "both splits inherit the same cwd" is not wrong, just not chained. Cache-hit (common case: an active shell with OSC-7 already seen) is still sync and preserves chaining.

### 3. Thread CWD through splitPane

`PaneManager.splitPane(paneId, direction, opts?)` currently accepts `opts: { ratio?: number }` (`pane-manager.ts:93-97`). Extend to `{ ratio?: number; cwd?: string }`.

Plumb the hint to `onPaneCreated` by widening its signature to `(pane, spawnHints?: { cwd?: string })`. The hint is forwarded synchronously inside `splitPane` and has no reason to outlive that call. The existing `pendingSplitScrollState` field on `ManagedPaneInternal` exists only because rAFs read it *later*; that is not the case here.

**Typed API break — all call sites of `onPaneCreated` must update:**

- `PaneManagerOptions.onPaneCreated` type declaration in `pane-manager.ts`.
- The `createPane` invocation at `pane-manager.ts:89` passes `undefined` for `spawnHints` (new panes aren't splits).
- The `splitPane` invocation at `pane-manager.ts:133` forwards `opts?.cwd` as `{ cwd: opts.cwd }` when set.

In `use-terminal-pane-lifecycle.ts`:

```ts
onPaneCreated: (pane, spawnHints) => {
  // ...existing handler install...
  const panePtyBinding = connectPanePty(pane, manager, {
    ...ptyDeps,
    ...(spawnHints?.cwd ? { cwd: spawnHints.cwd } : {}),
    restoredLeafId
  })
}
```

Spread order matters: `spawnHints.cwd` overrides the tab-level `ptyDeps.cwd`.

**Callers of `splitPane` — which inherit, which don't.**

| Call site | File:line | Passes `cwd`? | Why |
|---|---|---|---|
| Cmd+D / Cmd+Shift+D | `keyboard-handlers.ts:296` | **yes** | primary feature |
| Context menu: Split Right / Split Down | `use-terminal-pane-context-menu.ts:114,121` | **yes** | same user intent as Cmd+D |

Both Cmd+D and context-menu call sites receive a new dep `resolveSplitCwd: (paneId, ptyId, fallbackCwd) => Promise<string>` and replace `manager.splitPane(pane.id, dir)` with roughly:

```ts
const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
const cached = paneCwdRef.current.get(pane.id)
if (cached?.confirmed) {
  manager.splitPane(pane.id, dir, { cwd: cached.cwd })
  return
}
void (async () => {
  const cwd = await resolveSplitCwd(pane.id, ptyId, fallbackCwd)
  managerRef.current?.splitPane(pane.id, dir, { cwd })
})()
```

The keydown handler still calls `e.preventDefault()` / `e.stopImmediatePropagation()` synchronously before dispatching the async resolution — matches existing async pane-creation lifecycle.
| Worktree setup split | `use-terminal-pane-lifecycle.ts:693` | no | bootstrap command runs at worktree root by contract |
| Issue-command split | `use-terminal-pane-lifecycle.ts:719` | no | per-repo automation; runs at worktree root by contract |
| CLI-triggered split (`onCliSplitPane`) | `use-terminal-pane-lifecycle.ts:754,757` | no | CLI protocol today carries only `paneRuntimeId` + `direction`; no cwd field. Preserve today's behavior until the CLI protocol adds one. |
| Layout restore | `layout-serialization.ts:299` | no | restored panes re-emit their own OSC-7 on first prompt |

The setup/issue/CLI sites go through `splitPaneWithOneShotStartup`, which is a wrapper receiving a `() => manager.splitPane(...)` thunk. Widening the `splitPane` opts is backward-compatible; the wrapper is unaffected because the new `spawnHints` is a parameter of the `onPaneCreated` *callback*, not of `splitPane` itself.

`pendingSpawnByPaneKey` (`pty-connection.ts:21`) keys by pane key; each new split gets a fresh pane id, so no collision between the inherited-cwd path and existing dedup.

### 4. Preload / main bridge for `pty.getCwd`

`SshPtyProvider.getCwd` already exists (`ssh-pty-provider.ts:132`) and delegates to the relay which calls `resolveProcessCwd(pid, initialCwd)` via `/proc/<pid>/cwd` or `lsof`. Changes needed:

- **`LocalPtyProvider.getCwd` (`src/main/providers/local-pty-provider.ts:388`) currently `throw`s when the id is unknown and returns `''` otherwise.** Change: return `''` on unknown id (do not throw), and on a known id call `resolveProcessCwd(proc.pid, '')` where `proc = ptyProcesses.get(id)`. Pass `''` as the fallback — **not** the pane's initial cwd — because the renderer uses empty-string to mean "no result, try the next fallback layer"; returning the initial cwd would make the renderer think it had an answer and skip its own fallback chain. Do **not** throw on unknown id: the caller treats that case as non-exceptional.
- **Code sharing for `resolveProcessCwd`.** The helper currently lives in `src/relay/pty-shell-utils.ts` and is bundled into the relay binary. The Electron main process and the relay have separate build graphs; having main import from `src/relay/` (or vice-versa) is not a pattern this repo uses. Rather than force a `src/shared/` split (and touch the relay build), keep the relay's copy in place and add a tiny duplicate in `src/main/providers/process-cwd.ts` for `LocalPtyProvider`. The function is ~30 lines and has no shared state; the cost of duplication is lower than the cost of reshaping two bundle graphs.
- **IPC handler:** add `ipcMain.handle('pty:getCwd', (_e, {id}) => getProviderForPty(id).getCwd(id))` in `src/main/ipc/pty.ts`, and add `ipcMain.removeHandler('pty:getCwd')` to the removeHandler block at `pty.ts:325-331` (next to the existing `pty:hasChildProcesses` / `pty:getForegroundProcess` entries).
- **Preload:** add `pty.getCwd(id: string): Promise<string>` in `src/preload/index.ts` alongside `hasChildProcesses`/`getForegroundProcess`, and mirror in `src/preload/api-types.ts`. Returns `''` when unknown.

### 5. Edge cases

- **Agent TUIs (Claude Code, Codex, cursor-agent).** No OSC-7 because no shell prompt. `paneCwdRef` stays empty; `pty.getCwd` via `/proc/<pid>/cwd` still resolves against the running agent process.
- **Just-split panes (no OSC-7 yet).** A fresh pane before its first prompt has no entry. `pty.getCwd` fallback handles it. Double-Cmd+D inherits from the still-fresh shell's spawn CWD — correct.
- **SSH reconnect / cold-restore.** OSC-7 entries are keyed by ephemeral `paneId`. Replayed OSC-7 in the scrollback re-feeds the handler via `terminal.write` (`replay-guard.ts:47`) and repopulates the map with `confirmed: false`. The first live OSC-7 after the first prompt upgrades it to `confirmed: true`. If the user hits Cmd+D before the first live prompt, `resolveSplitCwd` takes the `pty.getCwd` path (which queries `/proc/<pid>/cwd` on the live shell) and only falls back to the replayed entry if IPC yields nothing.
- **Non-emitting shells.** Minimal `sh` without OSC-7 → `pty.getCwd` fallback carries it. Explicit reason to keep the two-layer strategy.
- **Windows.** `/proc` is absent and `lsof` isn't native. On Windows, `LocalPtyProvider.getCwd` must return `''` (fall through to worktree root) and must **not** throw — after the §4 change, the existing `throw`-on-unknown-id is replaced with `''`, and the Windows branch simply returns `''` unconditionally. Not a regression over today's behavior. OSC-7 from PowerShell/pwsh still works because parsing is renderer-side and platform-agnostic.
- **Expanded-pane mode.** `keyboard-handlers.ts:286` exits expanded mode before splitting. CWD lookup runs on the currently-active pane before that exit, which is the correct source.

### 6. Tests

- Unit: `parseOsc7` — BEL vs ST termination, percent-decoded spaces, empty host, Windows drive-letter URIs (`file:///C:/Users/...`). On Windows, `parseOsc7` must return a string that `node-pty` accepts as `cwd` on `spawn` (backslash- or forward-slash-separated, with drive letter, no leading `/`). Normalize inside `parseOsc7` via `path.win32.normalize` when `process.platform === 'win32'` and assert the test output equals what `spawn`'s `cwd` option tolerates — don't leave the choice implicit.
- Unit: `resolveSplitCwd` priority — OSC-7 cache hit skips IPC; cache miss queries IPC; empty IPC result falls through to `deps.cwd`; IPC timeout falls through to `deps.cwd`.
- Unit: `LocalPtyProvider.getCwd` returns `''` (not throws) for unknown ids.
- Integration (`tests/e2e/terminal-panes.spec.ts`): `cd /tmp && emit OSC-7; Cmd+D → new pane pwd === /tmp`.
- No SSH e2e suite exists in `tests/e2e/` today; skip.

### 7. Rollout / compatibility

- No migration or settings surface.
- Safe default: if OSC-7 and `pty.getCwd` both fail, fall back to worktree root. Users never end up worse off.
- Ships without a flag.

## Out of scope

- Persisting per-pane CWD across app restarts. Each session starts fresh; OSC-7 re-arrives on first prompt.
- **New-tab-from-pane inheritance (Cmd+T).** Deliberately deferred — users will ask why Cmd+D inherits and Cmd+T does not, but new-tab also implies worktree choice and startup payload semantics that are not in scope here. Reuse `paneCwdRef` + `resolveSplitCwd` when the new-tab flow is revisited.
- Using tracked CWD for status-bar display or any other non-split consumer. Separate features that can reuse `paneCwdRef` later.
- CWD for context-menu entries that open external tools (file manager, editor). Those already have their own resolution paths.
