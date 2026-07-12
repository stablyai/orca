# Cold-park reveal cost — measured

Companion to [`terminal-hidden-view-parking.md`](./terminal-hidden-view-parking.md).
Quantifies the reveal latency a user pays when returning to a terminal whose
hidden view was cold-parked, so the keep-warm policy is tuned from data rather
than guessed. Motivated by field reports that "terminal mounting is jumpy —
switching to a worktree after a while takes ~1s".

## How to reproduce

```bash
pnpm bench:cold-park-reveal -- --cycles=12                      # empty shell
pnpm bench:cold-park-reveal -- --cycles=10 --scrollback-lines=5000
pnpm bench:cold-park-reveal -- --cycles=10 --scrollback-lines=20000
```

The bench (`tools/benchmarks/terminal-cold-park-reveal-bench.mjs`) drives the
real dev app over CDP. Each cycle times a **cold** reveal (tab confirmed parked
via `window.__terminalParkingDebug.parkedTabIds()` before revealing) and a
**warm** reveal (revealed inside the hot-retain window, confirmed not parked),
so the cold−warm delta is the isolated cost of parking. It shrinks the 30s
hysteresis with `ORCA_E2E_TERMINAL_PARKING_DELAY_MS` and roots userData under a
short `~/.ocpb` path — the default `/var/folders` tmp path overruns the macOS
104-char Unix-socket limit, the daemon fails to bind, and terminals fall back to
non-snapshot PTYs that never park.

Phases per reveal (ms from the switch-back click): `activationMs` (store active
worktree flips), `ptyBindMs` (revealed pane has a bound pty — xterm remounted
and attached), `paintSettleMs` (two RAFs after ptyBind).

## Results (macOS, dev app, medians / p95)

| Scrollback | warm paintSettle | cold paintSettle | **cold-park penalty** |
| ---------- | ---------------- | ---------------- | --------------------- |
| empty shell   | 104 ms | 264 / 298 ms | **+160 ms** |
| 5 000 lines   | 131 ms | 318 / 423 ms | **+187 ms** |
| 20 000 lines  | 102 ms | 266 / 286 ms | **+164 ms** |

All cold samples confirmed parked (`parkedConfirmed = N/N`); all warm samples
confirmed not parked.

## Finding

**The cold-park reveal penalty is ~160–190 ms and effectively flat across buffer
size.** Growing scrollback 0 → 20 000 lines did not grow the penalty (the 20k
run is within noise of empty). So the cost is **fixed remount overhead** — React
subtree teardown/rebuild, fresh xterm construction, WebGL attach, fit, and the
reattach reset — **not** daemon snapshot replay, which scales fine.

Implications for tuning:

- The lever is **how often a remount happens**, not how much is replayed.
  Widening the keep-warm working set (worktree hot-retain limit is 4, tabs 12)
  and never parking the last-active tab per worktree remove remounts entirely
  for the common switch-away-and-back, which is worth more than shaving the
  ~170 ms remount itself.
- Pre-warming a predicted reveal (sidebar hover, jump-palette selection) hides
  the fixed cost behind the navigation instead of eliminating it.
- This synthetic terminal is a plain shell. A live agent TUI in the alternate
  screen pays additional reattach-reset + mode-rehydrate work on reveal (see the
  Grok-scrollback reattach path), so real-world cold reveals of a busy agent
  pane can exceed these numbers — the ~170 ms here is a floor for the mount
  overhead, not a ceiling for the full experience.

## Is parking worth having? (benefit side)

`tools/benchmarks/terminal-cold-park-resource-bench.mjs`
(`pnpm bench:cold-park-resource`) A/Bs the `terminalHiddenViewParking` setting
in one session: mount N worktree terminals, background all but one, then read
resources with parking off vs on. Measured at 8 backgrounded worktrees
(5 000-line scrollback each):

| metric | parking off | parking on | released |
| ------ | ----------- | ---------- | -------- |
| mounted pane managers | 9 | 1 | **8** |
| DOM nodes | 2 941 | 1 389 | **1 552** |
| attached WebGL contexts | 1 | 1 | **0** |

So parking's unique win is **releasing every hidden terminal's mounted view** —
8 xterm instances + their DOM subtrees (~1 550 nodes) here. At xterm's default
5 000-row scrollback, each terminal buffer alone is ≥ ~4–5 MB of typed-array
cell data (12 bytes/cell × 80 cols × 5 000 rows), so the renderer-memory floor
is on the order of **several MB per hidden terminal** — tens of MB across a
many-worktree session, before DOM and addon overhead.

Two honest caveats on the numbers:

- The **WebGL-context budget is NOT parking's win.** Even with parking off, only
  one context was attached across 9 mounted terminals — the separate
  WebGL-suspend-on-hide path (`suspendRendering`) already releases hidden panes'
  contexts. So the #6874 context-exhaustion protection stands with or without
  parking; parking's benefit is renderer memory + DOM, not contexts.
- The measured JS-heap delta was small (~1.7 MB) because detached xterm
  typed-array buffers GC lazily and the first measurement ran before they were
  reclaimed. The bench was upgraded to force multi-pass GC and read whole-app
  process memory (`window.api.memory.getSnapshot`), but a machine under disk +
  memory pressure could not complete the upgraded run (esbuild dev-service
  crashes). Re-run the upgraded bench on a healthy machine to get the settled
  whole-app memory figure; the pane-manager / DOM release above is the robust,
  reproducible part.

### Verdict

Parking earns its keep for the **many-worktree power user** (the reporter's
profile): it is the only mechanism that frees hidden terminals' view memory and
DOM, which is the dominant renderer cost at scale. It does **not** provide the
GPU-context protection (that is suspend-on-hide's job). The reveal price is a
flat ~170 ms remount. Net: keep it, and tune the keep-warm caps so the common
few-worktree rotation never pays the remount.

### Tuning applied

Because the reveal cost is a fixed remount, the levers are all about
**frequency**, not replay size. Three changes to
`terminal-hidden-view-parking.ts`:

- **Worktree hot-retain limit 4 → 8.** Eight covers the ordinary working set;
  at the ~4–5 MB renderer floor per hidden worktree that is ~16–20 MB worst
  case to eliminate remounts for the common rotation. Beyond 8, parking still
  reclaims for the heavy tail it was built for.
- **Hot-retain TTL 5 min → 15 min** (worktree and tab). The cap, not the clock,
  is the primary evictor now; 5 min was aggressive enough that a meeting-length
  absence parked the whole warm set. The tab count cap stays 12 (already
  generous).
- **Last-active exemption.** The single most-recently-hidden worktree/tab is
  never parked, regardless of TTL or cap, so returning to the view you just
  left is always instant. Implemented in `selectIdsBeyondHotRetain`; it holds
  one warm slot and counts against the cap.

Not done (deliberately): pre-warm on predicted reveal — it hides the cost
behind navigation rather than removing it and adds hover/prediction complexity;
and the 30 s cold-park delay is unchanged (it is the quick-flip guard).
