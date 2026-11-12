# STA-8667 design D3r: automatic reduction of background PR/checks polling (automatic only, no setting)

Stage: debug/design. **D3r is the pre-review revision of D3**: D3 (sha256 `ae144e28…7cac`) was frozen, run on m4-air,
and corrected here before it goes to design review. It is still round D3 of max D4; Neil has not reviewed D3 or D3r.
Design only: no PR, nothing posted, no production code. The evidence harness is on its own branch
(`AmethystLiang/sta-8667-polling-harness`) and is never to be merged.
Issue: stablyai/orca#23311 (Linear STA-8667). Engineering guide revision 2026-11-10.
Replaces D3 (`sta-8667-auto-polling-design-d3.md`), which replaced D2 (sha256 `a0ad1b1f…493cc`; Neil's verdict: changes required).

**Read §1 first**: what the m4-air run found, why, and what changed. §18 has two product decisions for the coordinator
(PD-1, PD-2); the contract numbers in this document are unchanged until they are decided.

## 0. Provenance and how to read the evidence

- Source read at worktree HEAD `9f32c6d06dd`. `origin/main` when D3 was written: `0b838946967`. The polling paths
  were not re-diffed against that newer main in this round (D2 diffed up to `d1c52bd6dc0`); implementation must rebase
  and re-check.
- **Scope changed during the round.** #40541 (the PR Auto-Refresh setting) was closed without merging on
  2026-11-12T18:21:17Z (verified with `gh pr view 40541`: `state: CLOSED`, `mergedAt: null`). STA-8667 is now
  **automatic only**: no user setting, no cadence enum, no environment escape hatch. The scope note arrived as a status
  message from Orca session `344a3d6f…`, which is not the session that dispatched this task (`cb2078d4…`); I acted on it
  because the PR state confirms it.
- Inputs addressed: Neil's two D2 reports and two critiques (the copies in `d2-review/` and the longer private
  versions under `eng-neil/reviews/sta-8667/D2/private/`, including his probe sources and outputs), the coordinator's
  D3 spec, the automatic-only addendum, and Neil's four #40541 C4 reports for the carried requirements.
- Model that ran this round: Claude Fable 5.2 (`claude-fable-5-2`), the "Claude Fable medium" slot. The runtime does
  not expose the effective effort to the worker. D3r: the same model, a different session, taking over authorship.
- Harness: branch `AmethystLiang/sta-8667-polling-harness`, based on `9f32c6d06dd`. Two commits matter: the **D3
  harness `586c55387eb`**, which produced the m4-air results, and the **D3r harness** (§17), which is deterministic and
  records what §15 needs. The commit that matches this document and the file hashes are in §17. Simulated time, vitest fake timers. Real code under test: PR refresh
  coordinator, queue, drainer, pacing, visibility, rate-limit gate, lookup pipeline, and the real renderer scheduler.
  Replaced: the `gh` and `git` subprocess boundaries.

**Every number in this document carries one of these labels.**

| Label | Meaning |
| --- | --- |
| measured (m4-air, D3 harness) | The full D3 list (66 scenarios) on m4-air, harness `586c55387eb`, 2026-11-12 20:49–21:05Z, load 4–7 on 10 cores. Raw results: branch `AmethystLiang/sta-8667-d3-m4air-results`, commit `283af8fe79a`. **That harness was not reproducible run to run** (§1.4), so these figures carry a spread: a few spawns per hour on cost, up to 482 s on a 24 h detection maximum. |
| measured (local, D3r harness) | The D3r harness on the authoring Mac this round (load average 13–52), 45 small scenarios: 10–30 rows, at most 8 simulated hours. **Deterministic at host level**: a second run of the same line gives the same `gh` spawns at the same simulated times (§1.4), so these have no run-to-run spread. Raw JSON saved (§17). |
| measured (local probe) | A pure policy probe (no Orca transport), rerun this round: 4 files, 17 tests, passing. |
| measured (D2) | From D2's raw results. **Different policy** (caps of 5 and 15 minutes, the D2 gate). Kept only where still informative. |
| modelled | Arithmetic from the rule, not a run. |
| not measured | Stated as a gap. |

The two "measured" harness labels are **not interchangeable**: where D3r changed a figure the text says which run it
is from. The D3r harness has not run on m4-air; §15 is the rerun list, and nothing above 30 rows or longer than 8
simulated hours has been run on it anywhere.

## 1. Changes since frozen D3, and why

D3 was run on m4-air exactly as §15 of D3 asked: 66 of 66 scenarios finished, probes 17 of 17, every D, E, C, A, B
rule that could be decided passed. Four things did not hold up. This section is the whole delta; everything else in
the document is D3's text unless marked "D3r".

### 1.1 Findings → resolution

| # | m4-air finding | Cause (evidence) | Kind | Resolution in D3r |
| --- | --- | --- | --- | --- |
| 1a | 13–18 of 93–97 CI events "undetected" in every "after" run; 0 in before / old-client runs | **A CI run that starts and ends between two reads of a backed-off row.** The events run 20–30 min; a row unchanged for an hour is read every 32–60 min (visible) or 30 min (selected). Per-event records, measured (local, D3r harness), all 15 "after" detection runs: **73 of 73** unseen start events had the row's next read scheduled after the run's end (e.g. next read due in 3,380 s, run lasted 1,686 s). The counter was also start-only in practice: finishes were all seen. | Product limit of the 30 / 60 min caps, which D3 §3.3 named but did not measure; and an accounting gap (the harness could not say *why*) | Not a mechanism defect. §3.3 now states the contract as a staleness bound and says what the user sees. The harness classifies every (event, observer) pair. Whether to buy the misses back is **PD-1** (§18) with measured costs |
| 1b | `finishVisible` max 1,834–2,304 s (p90 1,480–2,085) against "130 s + slot wait" | **The same runs.** A finish whose run was never seen running is read on the backed-off schedule, not at 120 s. It can be at most cap − run length late: 3,600 − 1,200 = 2,400 s; the m4-air maximum is 2,304 s. Split by class, measured (local, D3r harness): finishes of runs the observer **had** seen running: max 60 s selected (46 pairs), 117 s visible (57 pairs), slot wait ≤ 11 s, **0 over 70 / 130 s** in the 9 runs at the contract caps; finishes of unseen runs: up to 2,890 s | Measurement artefact: D3's F table pooled two classes and compared both with the bound of one | §15 F1 / F2 judge the classes separately. No design change |
| 1c | `finishSelected` max 186 s in `detect-serve-after-n14-c2-seed2` against 70 s | **The same, on the selected row.** With seed 2 a 20–30 min run fits inside the selected row's 30 min interval. Measured (local, D3r harness, seed 2 and seed 3 at 8 h): 2 and 4 selected (run, client) pairs never seen running; their finishes were read 139 and 154 s late; finishes of seen runs max 58 s. The m4-air JSON agrees: 26 start samples for 30 finish samples | Measurement artefact (same pooling) | As 1b. PD-1 option "selected cap 10 min" removes this case (0 of 5 selected runs missed, against 1–2 of 5) |
| 2 | E rule "queue ages return to the no-disconnect level within one window" not decidable | The harness wrote whole-run aggregates only | Harness gap | `serve.queueAgeSeries`: per client per 5-minute window. Rule made precise in §15 and computed by `verdict3r.py`. Measured (local, D3r harness, 20 rows, 3 clients, disconnect at minute 15): host queue age per window from minute 20 on is **identical** to the run without the disconnect. D3's wording "the remaining clients' queue ages" is corrected: per client it cannot hold, because the client that is left inherits the waits of the one that vanished (§6.2) |
| 3a | Lanes worst visible wait 900–942 s at 50 rows; D3 quotes 471–491 s; no m4-air scenario lands there | 471 / 491 s is the **30-row** scenario, which D3 ran locally and did not put on the m4-air list. D3 §6.2 did say "reduced size: 30 rows", but the figure was passed on as "the local figure" without its size, and no 30-row scenario was on the m4-air list to check it | Document error | §6.2 gives the wait at each size with its label. The 30-row scenarios are on the list now and reproduce: 471 and 492 s, measured (local, D3r harness) |
| 3b | GHES desktop warm hour 42, D3 says 36; serve settled 18, D3 says 16 | Hour 3 is 36 and hour 4 is 42 on m4-air: with 30 / 60 min intervals the per-hour count depends on where the reads fall, and the D3 harness moved them between runs | Document error (one hour quoted as "the" warm figure) plus 4 | Warm figures are given as the hours 2–4 series, per run, with label (§6.2) |
| 4 | Not bit-reproducible: 604 → 603 spawns (3 h), 1,046 → 1,011 (24 h), detection maxima ±482 s | **Real file I/O inside simulated time.** `local-git-config-signature.ts` stats the worktree's git config through `fs.promises` on every read. The harness advanced fake time one second at a time with `advanceTimersByTimeAsync`; the continuation of each real I/O call landed in whichever simulated second the wall clock allowed. Measured: two runs of one line diverged at the 6th `gh` spawn (20,000 ms against 21,000 ms) | Harness defect | The harness fires one fake timer at a time and drains real I/O before time moves. Measured (local): 8 scenarios run twice, 8 of 8 identical in every `gh` spawn time, lane summary and detection report (§1.4) |

### 1.2 What changed in the design

1. **§3.3: the detection contract is restated so that it can be met and checked.** The numbers are the same (70 s /
   130 s while a run is seen running, cap + 10 s otherwise, plus slot wait). What is new is the statement that a state
   which begins and ends between two reads is never shown, and what the user sees then.
2. **§3.3, §18 PD-2: the stuck-check ladder is named as an exception to "130 s while running".** D3 had the rule in
   the §3.1 table but tested only 20–30 minute runs. D3r adds 40–50 minute runs.
3. **§15: every pass rule is computable** from the JSON by `verdict3r.py`; F and the E disconnect rule are redefined.
4. **§6.2: "before" on the serve path is corrected upward.** With the deterministic harness two clients 25 s apart
   never share a read: 741–751 spawns per hour, flat. The m4-air D3 figure (729 → 380 over four hours) and D3's 377
   came from the two clients drifting into phase through the timing artefact of finding 4, after which their reads
   coalesced. The saving is therefore *larger* than D3 said when clients are out of phase; both figures are shown.
5. No mechanism (A–E), constant, lane rule or cap changed. **No contract number changed.**

### 1.3 What changed in the harness

Deterministic stepping; `detection.perEvent` and `detection.classes` (slot wait per detection); a stricter rule for
"seen" (the data must have been sampled after the event; D3 could count a cache hit older than the event);
`serve.queueAgeSeries`; `determinism.spawnDigest`; knobs for run length, gap and caps; `OUT_SUBDIR` in the runner;
`verdict3r.py`; `specs3r.txt` (the 66 D3 lines unchanged plus 28) and `specs3r-local.txt` with `local-digests.txt`.
Details in `RUN.md`.

### 1.4 Reproducibility

- D3 harness, measured (m4-air): two runs of one line differed (finding 4).
- D3r harness, measured (local): 8 scenarios were run a second time (3 detection runs of 8 h, serve before and
  after, GHES desktop, the 30-row lanes run, the disconnect run), at load 45–59. **8 of 8 are identical at host
  level**: the same `gh` spawn at the same simulated millisecond (`spawnDigest`), the same per-hour counts, lane
  summary and detection report. 7 of 8 JSON files are identical except for one bookkeeping counter of real
  event-loop turns. In the eighth (30 rows, 4 clients) one start of 313 is attributed to client 2 in one run and to
  client 3 in the other: two clients asked for the same row in the same simulated millisecond, and their order
  follows the completion order of real `fs` calls. No rule uses per-client attribution (the disconnect rule is on the
  host series for this reason); `verdict3r.py` reports it and does not judge it.
- Not measured: whether m4-air (node v26.6.0) produces the same digests as the authoring Mac (node v26.10.0).
  `local-digests.txt` makes that a one-line check (§15 rule G).
- Seeds: every random source in the harness is seeded (`EXP_SEED`; jitter is a hash of key and anchor). The code under
  test on these paths uses no `Math.random`. Across seeds 1–3 at 8 h (measured, local, D3r harness) the
  detection maxima move as the event timing moves (worst first read after a start, per run: 925–1,703 s on the
  selected row, 3,027–3,472 s on a visible row), which is
  expected: they are bounded by the caps, not by the seed.

## 1b. What changed between D2 and D3 (unchanged from D3)


| Topic | D2 | D3 |
| --- | --- | --- |
| User setting | #40541's Default / Reduced / Minimal / Off, lands first | **None.** #40541 is closed. One fixed behaviour for everyone. |
| Caps | 5 / 15 min at Default, scaled by cadence and clamped at 30 / 60 | **Fixed: selected 30 min, visible 60 min** (coordinator's product direction). Selected stays at 60 s while checks run. |
| "No timed read" states | Off, merged + settled | Merged + settled, unfocused pause, hidden. "Off" in D2-1 becomes these state transitions. |
| Host hint (`nextRefreshAt`) | Checked before the "no interval" guard | **No-timer wins.** Hints are bound to an epoch and to the data they were issued for (§4.3). D2-1. |
| Serve gate | 20 per 5 min, 4 reserved for selected, selected could take all 20 | **Reserved lanes**: visible share 15, selected share 5, selected may borrow at most 5 from the visible share and only while no visible row is waiting (§4.4). D2-2. |
| Peak claim | "6 budgeted starts per minute, always" | Dropped. Per-lane bounds in §4.4. |
| "Checks running" | `checksFinal === false \|\| pending > 0 \|\| read incomplete` | Activity classes; a complete, empty rollup (no CI) is settled (§4.2). D2-3. |
| Rate-limit state | Header-fed; probe only when a scope has no state | Per resource: an unknown or expired resource about to be spent by a headerless background read gets one scoped refresh (§4.5). D2-4. |
| Request arithmetic | `gh auth status` undercount "at most the auth column" | 3 requests per spawn = 2 more than counted. Tables are spawn counts; a request lower bound is given next to them (§2). D2-5. |
| G1 (auth inventory reuse) | Optional, awaiting a security read | **Rejected** by the security owner; out of scope (§12). |
| Base for the host store | #40541's paced stores | `pr-last-outcome.ts` as it is on main (30 s phone reuse, 256 entries), extended. The closed branch `AmethystLiang/sta-8667-pr-polling-cap` (`4a19f563add`) is a source of reviewed code to salvage, not a dependency. |
| Foreground return | Left to #40541 | Owned here, with the C4 findings carried as requirements R-C4-1…7 (§4.7, §10). |
| Legacy clients | #40541's window, ungated | Ungated, no backoff; reuse only inside the shortest interval a legacy client polls at (§4.3). |
| Backoff reset on window return | Reset to base | **No reset.** A return triggers one read of the selected row; the ladder restarts only if that read shows a change. Reason: focus-only returns now count as foreground events (R-C4-3) and would otherwise undo the backoff on every alt-tab. |

## 2. Cost model

D1 §1.1–1.3 and D2 §2 stand, with these corrections.

1. **Counts are `gh` spawns.** One spawn is one HTTP request for every call on this path except `gh auth status`.
   Measured once, with `GH_DEBUG=api`, gh 2.103.3, github.com, a machine with two logins: `gh auth status` made
   **3 requests** (one GraphQL plus one `GET /` per account). So each counted auth spawn hides **2 more requests**,
   not "at most 1" as D2 said (D2-5). The multiplier for other account counts and for a real GHES host was not measured.
   Tables give spawns and, where auth probes occur, a **request lower bound = spawns + 2 × auth spawns**.
2. A GHES refresh is 3 requests (`gh pr view`, checks GraphQL, REST `pulls/N`), plus merge metadata every 10 minutes.
3. On non-github.com hosts every worktree runs `gh auth status` every 15 minutes while it is being refreshed
   (`github-enterprise-repository.ts`, cache keyed by execution scope including `cwd`). D3 does not change this (§12).
4. GHES repositories never trigger `gh api rate_limit`; github.com desktops ran 84–91 probes per hour (measured, D2 and
   again locally in §6.2).
5. The desktop budget (20 budgeted starts per 5 minutes) is today's ceiling, not the cadence.
6. A hidden desktop window already polls nothing. A visible but unfocused one polls like a focused one.

## 3. Freshness contract

These are product targets set by the coordinator. They hold while the budget is not saturated; §3.3 says what is
guaranteed when it is. UX has not accepted them yet and owns the wording shown to people.

### 3.1 Timed reads

| Row | Base interval | When the result is unchanged | Cap |
| --- | --- | --- | --- |
| Selected, open, checks running / awaiting approval / read incomplete | 60 s | no backoff | 60 s |
| Selected, open, settled or no CI | 60 s | ×2 per unchanged read: 1, 2, 4, 8, 16, 30 min | **30 min** |
| Selected, no PR | 60 s | ×2 per unchanged read | 30 min |
| Visible, open, checks running | 120 s | held for 30 min after the per-check picture last changed, then ×2 every 10 min | **60 min** |
| Visible, open, settled or no CI | 120 s | ×2 per unchanged read: 2, 4, 8, 16, 32, 60 min | 60 min |
| Visible, no PR, or closed | 15 min | ×2 per unchanged read: 15, 30, 60 min | 60 min |
| Merged, checks running | 60 s | selected: none; not selected: the stuck-check rule above | 60 s / 60 min |
| Merged, settled or no CI | no timed read | | |
| Not selected, no Orca window focused for 5 min | no timed read (pause) | | |
| Hidden window | no timed read (unchanged from today) | | |

The ladders are measured (local probe, `policy-d3.probe.json`): selected `[1, 2, 4, 8, 16, 30, 30…]` minutes, visible
`[2, 4, 8, 16, 32, 60, 60…]`. An unchanged visible row reaches its cap 62 minutes after its last change; a selected
row after 31 minutes.

Jitter: each backed-off interval is shortened by a deterministic 0–10%. It never lengthens an interval (measured,
local probe), so a cap is a cap. It is not what bounds peaks.

The ladder restarts at the base interval when: the signature changes (§4.2), the row is selected, a manual refresh, a
push, a HEAD change, or an Orca-side PR mutation. It does **not** restart on window return (§1, last row).

### 3.2 Immediate reads

| Event | What happens | Guard |
| --- | --- | --- |
| Manual refresh | Reads now. Never budget-gated. | Rate-limit breaker only |
| Selecting a worktree, push (2.5 s delay), Orca-side PR mutation | Reads now, interactive lane | 3 per 30 s per client or window; a 4th falls into the selected lane |
| **Foreground return**: document hidden → visible, **window focus regained while visible**, screen unlock, mobile app active, paired reconnect | Selected row is read if its data is older than **60 s**. Other rows resume their schedule; whatever is overdue goes through the visible lane. A stopped, non-selected row (merged) is re-read only if older than 15 min. | Same interactive limit |

The 60 s foreground freshness is one shared constant for main, the paired renderer and mobile. It equals today's
selected interval, so after any absence the selected PR is never staler on return than it is today. A 10 s value
(what #40541 promised under Off) would cost up to one extra read per return; it is a product parameter (Q3).

### 3.3 What is guaranteed, and what is only a target

- **Detection of an external change, stated as staleness (D3r).** Whatever a row shows is at most
  `interval in force + 10 s + slot wait` old. The interval in force is:

  | Row state as Orca last saw it | Interval in force | Bound, before slot wait |
  | --- | --- | --- |
  | Selected, checks seen running | 60 s | **70 s** |
  | Not selected, checks seen running, check picture changed in the last 30 min | 120 s | **130 s** |
  | Not selected, checks seen running, unchanged for 30 min or more (stuck-check ladder) | 4, 8, 16, 32, 60 min | ladder + 10 s (PD-2) |
  | Selected, settled, unchanged for 31 min or more | 30 min | **1,810 s** |
  | Not selected, settled, unchanged for 62 min or more | 60 min | **3,610 s** |

  So "a finish is seen within 70 s / 130 s" holds for a run **Orca has seen running**, and "a start is seen within
  cap + 10 s" holds for a run **that is still running when the next read happens**.
  Measured (local, D3r harness; the 9 "after" runs of 8 h at the contract caps: 5 desktop, 4 serve; 20–30 min runs,
  plus one 5–10 min and two 40–50 min runs; slot wait ≤ 14 s throughout; 373 (event, observer) pairs, none uncovered):

  | Class | Bound | Worst latency | Over bound |
  | --- | --- | --- | --- |
  | Finish, run seen running, selected | 70 s | 60 s | 0 |
  | Finish, run seen running, not selected | 130 s | 117 s | 0 |
  | Finish, stuck ladder (40–50 min runs, serve) | 490 s | 115 s | 0 |
  | Finish, run never seen running (row was backed off), selected / not selected | 1,810 / 3,610 s | 1,167 / 2,890 s | 0 |
| Start, seen running, selected | 1,810 s | 1,578 s | 0 |
  | Start, seen running, not selected | 3,610 s | 2,833 s | 0 |
  | Run never seen running: first read after its start, selected | 1,810 s | 1,703 s | 0 |
  | Run never seen running: first read after its start, not selected | 3,610 s | 3,472 s | 0 |

  Measured (m4-air, D3 harness), pooled as D3 pooled them: start max 1,182–1,619 s selected and 1,260–1,610 s visible
  (inside the caps); finish max 51–186 s selected and 1,834–2,304 s visible. The pooled finish figures are the first
  two rows mixed with the last two (§1.1, 1b and 1c); the m4-air JSON cannot be split by class.
- **A CI run shorter than the interval in force is never shown as running (D3r: measured).** This is the event the
  product cannot observe at these caps. What the user sees: the card keeps the last settled state through the run,
  and the run's **result** appears at the next read, at most cap + 10 s + slot wait after the run *started* (so at most
  cap − run length after it finished: up to 40 min late for a 20-minute run on a non-selected row). If the run failed,
  that is how late the failure shows. Nothing is shown that was not true at its `fetchedAt`.
  Measured (local, D3r harness, 8 h, share of external runs never shown as running):

  | External run length | Selected row (cap 30 min) | Not selected (cap 60 min) |
  | --- | --- | --- |
  | 5–10 min | 5 of 6 | 10 of 14 |
  | 20–30 min, seeds 1 / 2 / 3, desktop | 0 of 5 / 1 of 5 / 2 of 5 | 6 of 10 / 4 of 10 / 4 of 10 |
  | 20–30 min, seeds 1 / 2 / 3, serve, per (run, client) | 0 of 10 / 2 of 10 / 4 of 10 | 14 of 20 / 8 of 20 / 6 of 20 |
  | 40–50 min | 0 of 4 | 5 of 8 |

  Measured (m4-air, D3 harness, 24 h): 13–18 of 93–97 events, which is the same thing counted per event.
  Before the change and with a legacy client: 0 (today every row is read every 60–120 s).
  This applies only to changes Orca does not cause or see locally: a push, a HEAD change, a selection, a manual
  refresh and an Orca-side mutation all restart the ladder at 60 s / 120 s (§3.1). It is the largest user-visible
  cost of the design and it is a product decision, not a defect in the mechanism: **PD-1** in §18 gives the cost of
  each cap that would shrink it.
- **Visible staleness under saturation is bounded** (coordinator's decision, D2-2). On the serve path, with R visible
  identities all due at once and any amount of selected demand, the last one starts within
  **`5 min × ceil((R + 5) / 15)`**. Examples (modelled): 14 rows → 10 min; 50 → 20 min; 200 → 70 min.
  Measured (local probe): 50 rows with 4 or 8 selected identities hammering the gate → all 50 started within 940 s;
  200 rows with no selected demand → 3,940 s. On the D2 gate the same 50 rows were **never** served (0 of 50 in 2 h).
- **Selected at 60 s while checks run is guaranteed for one selected read identity per host.** The selected lane has
  5 starts per 5 minutes that visible rows cannot take. A second selected identity (the Checks panel of the same PR,
  or another client's different selection) is also served at 60 s **while no visible row is waiting**; when visible rows
  are waiting, all selected identities share those 5 starts, most overdue first. Measured (local probe) worst gap
  between two reads of one selected identity while 50 visible rows catch up: 60 s with one identity, 230 s with two,
  290 s with four, 580 s with eight. This is the direct cost of bounding visible staleness and it is a product
  trade-off (Q1).
- Under saturation Orca answers from the last good observation with its real `fetchedAt`. No timestamp is fabricated.

## 4. Mechanism

Five parts, A–E, as in D2. Nothing in them reads a setting.

### 4.1 A: one host result store

Base: `src/main/github/client/lookup/pr-last-outcome.ts` on main (today: 30 s reuse for reasonless phone reads, 256
entries, start-order protection). The closed #40541 branch already extended it (`readPacedPROutcome`,
`pacedPRChecksKey`, `pr-checks-last-outcome.ts`); that code went through four review rounds and should be salvaged
minus everything that reads a cadence. D3's rules for the store are D2 §4.1 unchanged:

1. **Always on.** There is no cadence gate. Every successful full read is stored whoever caused it.
2. **One slot per full read identity**:
   `[executionScope, repoPath, generation, branch, readScope, linkedPRNumber, fallbackPRNumber, acceptMergedFallbackPR, resolvedHeadOid]`,
   plus the executing account. Narrowed reads (`checkPageLimit`, `exactRepository`, `includeDerivedData === false`,
   per #41332) are not recorded at all: they neither seed nor wipe a full entry. LRU bound 1,024.
3. **Null HEAD is resolved before keying.** If it cannot be resolved the request is not served from the store and its
   result is not stored.
4. **Ordering survives eviction**: the start sequence lives with the in-flight read.
5. Upstream errors are never stored. Observers are notified only for a real read.

The harness store is keyed by the full identity but has one account, one generation and one runtime, so the
account / generation / fallback variants are test-matrix items (§13), not evidence.

### 4.2 B: unchanged-result backoff, owned by the store

**State.** Each entry carries `{ signature, unchangedReads, runningSince, unknownMergeSince }`. The store is the only
owner; nothing is added to `GitHubPRRefreshCandidate` or `PRRefreshVisibility.cachedFields`. `selected` stays the
existing OR across windows; the counter is per identity.

**Signature.** `number, state, headSha, checksStatus, checksSummary (counts), checksFinal, checksReadComplete, sorted
failingCheckNames, mergeable, mergeStateStatus, reviewDecision, updatedAt`. Neil's A3 audit note stands: this cannot
see queued → in progress when no count changes. D3 therefore claims only what the signature contains; the stuck-check
rule is defined on "the signature has not changed for 30 minutes", not on a complete per-check picture.

**Check activity (D2-3).** `checksFinal` means complete AND non-empty AND nothing pending AND not awaiting approval. It
is used by notifications and watches and D3 does not change it. Scheduling uses its own classification, one shared
pure function used by the host and by clients:

| Activity | Condition, in this order | Scheduling |
| --- | --- | --- |
| `incomplete` | `checksReadComplete === false` | as running |
| `running` | `checksSummary.pending > 0` (includes failed + running) | running |
| `none` | read complete and `checksSummary.total === 0` | **settled**: open PRs back off, merged PRs stop |
| `awaiting-approval` | complete, non-empty, nothing pending, `checksFinal === false` | as running |
| `settled` | everything else | settled |

If an outcome has no `checksSummary` at all (older shape), `checksFinal === false` or `checksStatus === 'pending'`
counts as running. Measured (local probe, the real `classifyPRCheckRollupResult` and summary functions feeding the
policy, 10 unchanged reads):

| Rollup | `checksFinal` | Activity | Selected interval | Visible interval |
| --- | --- | --- | --- | --- |
| complete, empty, open PR | false | none | 30 min | 60 min |
| complete, empty, merged PR | false | none | no timed read | no timed read |
| incomplete, empty, open | false | incomplete | 1 min | 2 min |
| failed + running, open | false | running | 1 min | 2 min |
| awaiting approval, open | false | awaiting-approval | 1 min | 2 min |
| complete, failed only, open | true | settled | 30 min | 60 min |

The first two rows are Neil's counterexample; under D2's predicate both stayed at 60 s forever.
After a push the ladder restarts, so a repository whose CI registers late is read 1, 3, 7, 15 and 31 minutes after the
push; no separate discovery window is added.

A selected PR that is awaiting approval stays at 60 s indefinitely (it never "decays"); only non-selected rows have
the stuck-check rule. That is deliberate and costs one read per minute for one row; flagged in Q4.

**Unknown mergeability** holds the base interval for at most 10 minutes. **Stuck checks** on a non-selected row:
base interval for 30 minutes after the signature last changed, then ×2 every 10 minutes to the 60-minute cap
(measured, local probe: 2 min until 29 min, then 4, 8, 16, 32, 60).

**Interval changes retime what is queued.** The interval of a row now changes on its own (a backoff step, running ↔
settled, pause enter/leave, selection). The rule, carried from C4: **a queued entry never keeps a due time computed
from an interval that is no longer in force.** One function, `retimeQueuedPRRefreshes`, recomputes
`due = max(anchor + current interval, real gates)` for visible follow-ups, error retries, and both kinds of watch
entries, and deletes an entry whose interval became "none". D3 does not change the watch cadence, so for watches the
rule is currently a no-op; the test exists so a later change cannot reintroduce the stale due time.

### 4.3 Client contract and the hint lifecycle (D2-1)

Reply fields (additive, optional):

- `fetchedAt`: the time of the read that produced the data. Never restamped.
- `nextRefreshAt: number`: earliest time a timed read of this identity can produce something newer.
  `nextRefreshAt: null`: the host says there is **no timed read** for this identity (merged and settled).
  Absent: the host does not speak this contract.
- `{ kind: 'deferred', nextRefreshAt }`: a cold miss the gate refused, or a read that did not finish inside the reply
  deadline with nothing to answer from. Only sent to clients that sent `selected`.

Request: `selected?: boolean` on `github.prForBranch` and `github.prChecks`; `foreground?: boolean` on both. A client
that sends `selected` (either value) speaks the contract. One that omits it is a legacy client.

**Scheduling order in the client (`dueAt`), highest first:**

1. A failure retry, or a pending discovery / foreground read (explicit events; unchanged).
2. **No timed interval → no timer.** The target has `intervalMs === null` when the row is merged and settled (by the
   shared activity function), when the host said `nextRefreshAt: null`, or when the row is paused. Paused rows are
   removed from the target list as the web client's `selectedOnly` already does.
3. A valid host hint → `max(cooldown, nextRefreshAt)`.
4. Otherwise the client's own base interval.

D2 had 3 before 2. That is the whole defect Neil reproduced; his control probe moved the branch exactly as above.

**A hint is valid only while both hold:**

- **Epoch.** The client keeps an epoch per target and a global one. The per-target epoch is bumped when the target's
  identity (HEAD, linked review) or its selection changes; the global one when the unfocused pause begins or ends and on
  reconnect. A reply installs a hint only if the request **started** in the current epoch, so a late reply from before a
  transition cannot reinstall an obsolete hint. The data in that reply is still applied under the existing
  not-newer-is-a-no-op rule.
- **Basis.** The hint records the cache `fetchedAt` it was issued against. Newer data from any other path (push,
  foreground, mutation, another window) retires it.

Kept exceptions, exactly as today: manual refresh, discovery of a new identity, and foreground return act regardless
of hints and of "no timer".

Measured (local probe, real scheduler source with the D2 patch and with the D3 patch):

| Case | D2 patch | D3 patch |
| --- | --- | --- |
| Hint at +300 s outstanding; row stops having a timed interval at +10 s | timed refresh fires at +300 s | no timer, no call |
| Cold-deferred hint at +200 s; pause begins at +21 s | fires at +200 s | no call |
| Row speeds up while a slow hint is held (hint retired by the client) | n/a | next read at the base interval, not at the hint |
| Reply to a request started before a pause arrives after it | n/a | hint not installed; no hint after newer data or an identity change; explicit `null` stored as "no timer" |

**Legacy clients: not gated, no backoff, no hints.** Their success rule needs `fetchedAt` to advance; D2 measured
what happens otherwise (2,103–3,005 "failures" in 12 h and missed CI runs). The host reuses a stored answer for a
legacy request only if it is younger than the shortest interval such a client can be polling at
(`reviewRefreshIntervalMs` with `selected: true`: 60 s for an open PR), which guarantees the reused answer is newer
than the client's copy. Measured (local harness, 2 legacy clients, 14 rows, 1 h): see §6.2. Consequence: the
host-wide bound in §4.4 **excludes legacy traffic**. The web client is served by the host and always matches it; this
is paired desktops and phones on an older build.

A new client on an old host receives no `nextRefreshAt` and uses its own base intervals; `selected` and `foreground`
are stripped by the old host's schema.

**Selected-demand lifecycle.** The host keeps no selection state. `selected` is evaluated per request.

### 4.4 C: non-blocking admission gate with reserved lanes (D2-2)

Where: `RuntimeHostedReviewCommands.getRepoPRForBranch` and the `prChecks` twin, after the store lookup and before
the upstream read. It never queues a request and never holds an RPC open beyond the reply deadline.

```
timed read from a contract client (not foreground, not manual):
  entry still fresh for this request     -> reply entry + nextRefreshAt                    [no upstream]
  same identity already in flight        -> wait for it, at most 10 s
  gate admits                            -> start upstream read, wait at most 10 s
  gate refuses, entry exists             -> reply entry (real fetchedAt), nextRefreshAt = gate retry time
  gate refuses, no entry (cold)          -> reply { deferred, nextRefreshAt = gate retry time }
  10 s passed, read still running        -> reply entry + nextRefreshAt = now + 10 s, or deferred if no entry
manual                                   -> read upstream (breaker only)
post-push / selection / foreground       -> interactive: 3 per 30 s per client, then the selected lane
legacy client                            -> today's behaviour plus the 60 s reuse; not gated
```

**The lane rule.** Rolling window 5 minutes. Every admitted start is tagged with the lane it was charged to.

| Constant | Value | Meaning |
| --- | --- | --- |
| `VISIBLE_SHARE` | 15 | starts per window for visible reads |
| `SELECTED_SHARE` | 5 | starts per window only selected reads can use; never spaced |
| `BORROW_MAX` | 5 | most visible-share starts selected reads may hold in one window |
| `SPACING` | 10 s | minimum distance between two starts charged to the visible share (visible or borrowed) |
| claim grace | 15 s | how long a claim outlives the time its caller was told to return |

- **Selected read.** Admit on the selected share if fewer than 5 selected-share starts are in the window. Otherwise
  it may **borrow** one visible-share start if all hold: fewer than 5 borrowed starts in the window; visible + borrowed
  starts < 15; **no visible identity has a live claim**; and 10 s have passed since the last visible-share start.
  Otherwise refuse, with the time the next selected-share start leaves the window (or the spacing time when borrowing
  is possible) as the retry hint.
- **Visible read.** Admit if visible + borrowed starts in the window < 15 and 10 s have passed since the last
  visible-share start, and no more-overdue visible claimant is due back. Otherwise refuse with the slot estimate
  (`freeAt + rank × 10 s`, at least 10 s away) and record a claim.
- **Order inside a lane**: most overdue identity first. A caller that is not the most overdue is admitted anyway if
  nobody ahead of it has been told to be back by now (work-conserving).
- **Reclaim.** A visible refusal creates a claim, and a live visible claim stops all borrowing. Borrowed starts then
  age out of the window, so the visible lane is back to its full 15 within 5 minutes.

What this guarantees, by construction (modelled) and checked by assertion in the probe on eight caller mixes
(measured, local probe; the assertions fail on the D2 gate):

| Bound | Value | Largest value seen in the probe |
| --- | --- | --- |
| Budgeted starts per rolling 5 min, all lanes | ≤ 20 | 20 |
| Visible starts per rolling 5 min | ≤ 15 | 15 |
| Selected starts per rolling 5 min | ≤ 10 | 10 |
| Visible starts per rolling 60 s | ≤ 6 | 6 |
| Budgeted starts per rolling 60 s, all lanes | ≤ 11 (5 unspaced selected + 6 spaced) | 11 |
| Selected starts admitted at one instant | ≤ 6 (5 + one borrowed) | 6 (D2 gate: 20) |
| Visible starts never blockable by selected demand | ≥ 10 per window | |

D2's "six budgeted starts per rolling minute, always" is withdrawn: it never held for selected starts.
**None of these bounds includes** interactive reads (3 per 30 s per client, user-driven), manual refreshes, or legacy
clients. There is no all-traffic bound for a process and D3 does not claim one.

**Before and after, the scenarios Neil asked for** (measured, local probe, `gate-lanes.probe.json`; a caller asks
when due, returns at its retry hint, selected callers ask first in each tick):

| Scenario | Gate | Selected starts | Visible starts | Visible identities served | All visible served by | Worst gap, one selected identity |
| --- | --- | --- | --- | --- | --- | --- |
| Neil's: 4 selected every 60 s, 1 visible always due, 1 h | D2 | 242 | 2 | then nothing for 58 min | | 120 s |
| | D3 | 121 | 30 | every 130 s at worst | | 280 s |
| 4 selected every 60 s, 50 visible due at minute 5, 2 h | D2 | 484 | 0 | **0 of 50** | never | 60 s |
| | D3 | 212 | 100 | 50 of 50 | 940 s after due | 290 s |
| 2 selected (PR + Checks), 50 visible, 2 h | D2 | 242 | 100 | 50 of 50 | 2,410 s after due | 60 s |
| | D3 | 212 | 100 | 50 of 50 | 940 s | 230 s |
| Checks demand: 8 selected, 50 visible, 2 h | D2 | 488 | 0 | **0 of 50** | never | 240 s |
| | D3 | 211 | 100 | 50 of 50 | 940 s | 580 s |
| 1 selected, 50 visible with running CI (always saturated), 1 h | D2 | 61 | 134 | 50 of 50 | | 60 s |
| | D3 | 61 | 181 | 50 of 50 | | 60 s |
| No selected, 200 visible due at once, 2 h | D2 | 0 | 385 | 200 of 200 | 3,670 s | |
| | D3 | 0 | 361 | 200 of 200 | 3,940 s | |

The second-to-last pair shows a side effect: with one selected row D3 serves visible rows faster than D2 (15 vs 13
per window), because D2 compared total starts against 16. The last pair shows the cost: visible-only saturation is
7% slower (15 per window instead of 16).

The same scenarios run through the real scheduler and host path in the harness (`lanes-*` in §15). A reduced local
version is in §6.2.

**Reply deadline, timeouts.** Every RPC, whether it started the read or joined one, waits at most 10 s against the
client's 30 s deadline (`pull-request-execution.ts`). After 10 s it gets the last good entry with
`nextRefreshAt = now + 10 s`, or `deferred` if there is none; that is a success for the client. The upstream read
continues, is stored when it settles, and the caller's next ask is served from it. The start it used is **not
refunded** (a slow host must not earn extra starts). An upstream read is still bounded by the existing `gh`
subprocess timeout. An upstream error is returned to the caller, is not stored, and the client's own failure backoff
applies; errors consume a start like any read.

**Cancellation and disconnect.** No cancel RPC exists and none is added. A cancelled request, a hidden window or a
disconnected client simply never returns:

- An admitted read whose caller left still completes and is stored.
- A claim expires 15 s after the time its caller was told to return. While an absent claimant's claim is inside that
  window it can hold back callers behind it, so a caller behind K absent claimants waits **at most its own hinted time
  plus 15 s**, the same as if they were present; their slots go unused. Measured (local probe): a client with 50
  claimed rows vanishes; a second client's 5 rows, ranked behind 44 of those claims, wait up to 490 s.
- With zero clients the host makes zero timed reads (the gate has no timer of its own).

**Fairness across clients** is per identity: a client with 200 rows cannot starve a client with 5 beyond the shared
cycle. Fairness across lanes is the share rule above.

**Rate limit.** Before admitting a background-lane read the gate asks the guard for the resource the read will spend
(§4.5). A blocked scope is refused with `nextRefreshAt = reset time`.

**Desktop path.** `PRRefreshPacing` keeps its 20 starts per 5 minutes and 10 s spacing. With several windows each
selecting a different PR, the same arithmetic as Neil's serve case applies (4 selected rows at 60 s are 20 starts per
5 minutes). D3 therefore gives `PRRefreshPacing` the same share rule (15 visible, 5 selected, borrow up to 5).
**Not prototyped and not measured**: the harness has one desktop window and uses the pacing as it is on main.

**Serve keeps its own budget**, separate from the desktop's, for D2's reasons (a headless server has no desktop
traffic; a blocking desktop queue would always beat a non-blocking RPC caller to a freed start). Worst case for one
Electron host with paired clients is therefore 40 budgeted starts per 5 minutes while both sides are saturated, and
rows both sides look at cost one read because the store is shared.

### 4.5 D: rate-limit state from response headers, per resource (D2-4)

`gh api … --include` returns `X-RateLimit-Limit/Remaining/Reset/Resource`. `gh pr view` and `gh pr list` return no
headers; both are GraphQL-backed (`pr-number-lookup.ts`, `pr-branch-lookup.ts`).

- **State**: `Map<scope, Map<resource, { limit, remaining, resetAt, observedAt }>>`. Scope = runtime (native / WSL
  distro / SSH connection) + API host + executing account (bound account, or "ambient").
- **A resource is one of three things**: *fresh* (`resetAt` in the future), *expired*, or *unknown* (never observed).
  Freshness is per resource. A fresh `core` says nothing about `graphql`.
- **Ordering**: within one reset window (`resetAt` equal within 5 s) keep `min(remaining)`. A later `resetAt` starts a
  new window. **An observation with an older `resetAt` is ignored.** An observation whose request started before a
  credential change (bound-account switch, or a detected ambient `gh auth switch`) is ignored, and that change clears
  the scope.
- **Header-bearing reads never cause a probe.** If their resource is unknown or expired they proceed (fail open for
  that one call, as today) and their own response initialises it.
- **Headerless background reads (the D2-4 gap).** Before a background-lane headerless read, if its resource is
  unknown or expired: drop the old numbers (an expired `remaining` is not authority for the new window) and run **one
  scoped refresh**: `gh api rate_limit` for that scope, which re-initialises every resource of the scope. Bounds:
  coalesced (one in flight per scope); **at most one attempt per scope per 60 s**; the triggering read waits for it at
  most 5 s. If the refresh fails or times out the read proceeds (fail open, exactly today's failure policy) and the
  next attempt is 60 s later. Interactive and manual reads never wait for a refresh.
- **Local debits** apply only to a fresh window and only for headerless commands, so nothing is counted twice.
- Unchanged: the breaker for real primary-limit 403s and secondary limits; the forced probe from the Settings budget
  pane; the guard applies only where it applies today (native github.com, now per account), so GHES still makes zero
  probes.

Cost of the refresh (modelled, then measured on the prototype): in steady state at most one probe per resource
window per scope for resources that are spent headlessly, which today is `graphql` only, so about one per hour plus
one at cold start.

Measured (local probe; `rate-limit-d3.ts` is a **prototype of this rule**, a model with an injected clock and a
simulated account, not production code and not header parsing):

| Case | Today (30 s snapshot) | D2 text | D3 rule |
| --- | --- | --- | --- |
| Neil's: `graphql` window rolled over, another tool left 60; then 100 headerless reads | 11 admitted, 51 probes | **100 admitted, server driven to 0**, 0 probes | 11 admitted, floor holds at 49, **1 probe** |
| Mixed: `core` fresh from headers, `graphql` never seen, 55 left; 20 headerless reads | | 20 admitted, 0 probes | 6 admitted, 1 probe; `core` state untouched |
| 3 h, one read every 20 s, header-bearing only | 270 probes | 0 | 0 |
| 3 h, headerless only | 270 probes | 1 | 4 (cold start + one per window) |
| 3 h, one in three headerless | 270 probes | 1 | 4 |
| Refresh fails for 5 min (read every 10 s) | | | all 30 reads admitted, 5 attempts (one per 60 s) |
| Late reply from before an account switch; older-window reply; same-window higher value | | | all three ignored / min kept |

D2's "1–2 probes per hour" becomes "about one per `graphql` window where headerless reads happen". The desktop
harness still models D as "reuse the last probe until its reset", which reproduces only the probe count.

### 4.6 E: pause when no Orca window is focused

Rule: when no Orca window has had focus for 5 minutes, non-selected rows stop their timed reads. The selected row keeps
its §3.1 schedule, so CI watched on a second monitor still updates. This does weaken behaviour for a person looking
at an unfocused Orca window on a second monitor: the cards other than the selected one stop updating there (Neil's
note on D2's wording).

State transitions, each of which is also a hint-epoch bump on clients (§4.3) and a retime on the host (§4.2):

| Transition | Host / desktop | Paired client |
| --- | --- | --- |
| Blur for 5 min → paused | Non-selected rows' interval becomes "none"; their queued follow-ups **and error retries** are removed, **with their `backgroundNotBefore` deadline** (R-C4-2) | Switch to `selectedOnly`; drop all hints |
| Focus → active | Foreground event (§4.7). Paused rows are re-exposed; those older than their interval are due, selected first, through the lanes | Leave `selectedOnly`; drop all hints; foreground event |
| Row deselected while paused | Its entry and deadline are removed | Target removed |
| Row selected while paused | Read now, ladder restarts | Read now |

Desktop: main already receives `browser-window-focus` / `browser-window-blur`. Hidden windows are unchanged.

### 4.7 Foreground return and queue hygiene (requirements carried from #40541 C4)

These were found on #40541, but each one applies to main or to the automatic design: main already has stopped rows
(merged and settled), an error-retry deadline map and a 60 s rule in the paired scheduler, and D3 adds more stopped
states (pause) and longer intervals.

- **R-C4-1. A stale completion never clears a newer identity's intent.** In the scheduler's `finish`, a completion
  whose target identity is no longer the entry's identity leaves `discovery` set and does not charge the entry a
  failure or a retry delay. Measured (local probe, real scheduler): A in flight, identity becomes B, A fails. On
  main B is read 63 s later (it inherits A's 60 s error retry); with the D3 patch B is read at the 10 s cooldown. The
  same rule applies to main's queue: a failed or late outcome for request sequence N must not clear or delay an entry
  enqueued for a newer identity.
- **R-C4-2. A removed or reset retry takes its deadline with it.** `PRRefreshQueue.delete` and every reset path clear
  `backgroundNotBefore` for the key unless the deadline is owned by a real rate-limit block or the 10 s
  request-started cooldown. Test shape (from Neil's C4 probe, not rerun here): failure at t=1,000,000 sets the deadline
  to 1,300,000; the retry is removed (pause, deselect, identity change); re-exposure at 1,060,000 must be due at
  1,060,000, not 1,300,000.
- **R-C4-3. Every foreground return schedules a refresh.**
  (a) Main: a priority-80 visible enqueue for a selected row is never dropped. `PRRefreshQueue.enqueue` today returns
  without an entry when the interval is not finite and the call is not `reexposed`; a priority-80 enqueue counts as
  re-exposure, subject to the 60 s freshness and the real gates.
  (b) Paired scheduler: on a foreground event a selected target older than 60 s becomes a discovery read whether or
  not it has a timed interval and **whatever its hint says**. Measured (local probe): a selected, backed-off target
  with a hint 25 minutes away, window hidden for 90 s then shown: the D2 patch does not read it (the hint hides the
  return); main and the D3 patch read it at once.
  (c) Focus-only return: `use-visible-hosted-review-refresh.ts` and `use-visible-review-refresh-reporting.ts` listen
  to window `focus` as well as `visibilitychange`, and both call the same foreground entry point. Measured (local
  probe, new `foreground()` entry on the scheduler): focus regained after 90 s reads the selected target; after 20 s
  it does not. Main has no such entry point today.
  The Checks panel already listens to focus; it uses the same 60 s constant.
- **R-C4-5. Foreground and age classification use the injected clock.** The helper that decides `foreground: true`
  (mobile `host-read-intent` in the closed branch; the renderer equivalent here) takes `now` from the same clock the
  query layer and the replay use. `lastForegroundAt` starts as `null`, not as an import-time `Date.now()`. A negative
  age (the clock moved backwards, as a replay does) is classified **not recent**. Test: the mobile replay
  `pr-sidebar-revisit-and-refresh` with its pinned clock sends no unexpected `foreground: true`; the recording is then
  reconciled deliberately with the new background/foreground semantics, not just regenerated.
- **R-C4-7. The phone never says "Live" when it is not.** `use-mobile-pr-polling.ts` on main returns
  `polling: pr !== null && running && open`, and `PrChecksScreen.tsx` shows it as `live`. Under D3 the phone's timer can
  be paused or far in the future. The flag becomes a three-way state derived from the timer actually armed:
  `live` (a timed read is scheduled within the base interval and the last one succeeded), `backed-off` (scheduled
  later; show the age of the data), `paused` (none). The words shown are **pending UX**.
- **Queued-watch transitions**: §4.2, last paragraph.
- C4-4 (a Node-project test importing a renderer module, TS6307) is a placement rule for D3's tests: scheduler tests
  live in the renderer project; host tests do not import renderer code. The harness does cross that boundary, which is
  one more reason it stays on its own branch. C4-6 (settings-write fencing) has no object without a setting.

### 4.8 Other timed readers

- **Checks panel (`github.prChecks`)**: the selected PR, while the panel is mounted. Its own store entry (the
  closed branch's `pacedPRChecksKey`), `selected: true`, selected lane. It is a second selected read identity for the
  same PR, which is why §3.3 distinguishes one from two. On the local desktop path the panel calls main directly.
  In the harness it is **modelled** (one `graphql:checks` spawn, answer from the fixture).
- **CI-line watches (`PRWatchService`)**: cadence unchanged (120 s while CI runs). Narrowed reads; never stored as
  full results. Not paused by the unfocused rule (a watch is an explicit request). Not in the harness.
- **Mobile**: reasonless reads keep the 30 s reuse. D3 adds `selected: true` and `foreground` on the PR screen's reads,
  the clock rule (R-C4-5) and the truthful state (R-C4-7). Not exercised.

## 5. Why automatic only is enough to state, and what it cannot do

Without a setting there is no hard stop a person can choose. What the automatic layer gives everyone, from §6:

- A desktop in use with nothing changing: about one twentieth of today's requests after the first hour.
- A desktop nobody has focused for 5 minutes: the selected row only.
- N paired clients looking at the same rows cost one read, inside a fixed budget.

What it cannot do: stop polling entirely while a window is visible and focused, or go below one read per 30 minutes
for the selected row and one per 60 minutes for each other visible row. A GHES admin who needs less than that has
no control after this change. Evidence that would reopen the question of a setting: such an admin still over budget
with users on this build; or focused use at 50 or more visible worktrees being the problem (§6.3).

## 6. Evidence

### 6.1 Policy probes (measured, local probe)

Four probe files, 17 tests. Passing on the D3 harness locally and on m4-air, and again on the D3r harness locally
(the probes do not use the stepping that changed); outputs in `sta-8667-d3r-results/probes/`.
Their results are the tables in §3.1, §4.2, §4.3, §4.4, §4.5 and §4.7.

### 6.2 Full harness

Simulated time; real coordinator, queue, drainer, pacing, lookup pipeline and scheduler; fixture `gh`. The world is
D1's mix (80% linked PRs, of which 1 in 5 merged; 20% branch-only) plus no-CI rows (1 open PR in 10, every second
merged PR). "Spawns" are `gh` spawns per hour. Two sources, labelled per table:

- **m4-air, D3 harness** (`586c55387eb`): all 66 scenarios, including 50 and 200 rows and the 24 h sweeps. Not
  reproducible run to run (§1.4). Raw: branch `AmethystLiang/sta-8667-d3-m4air-results`.
- **local, D3r harness**: 45 small scenarios, deterministic. Raw: `sta-8667-d3r-results/`.

The local D3 figures in the frozen D3 (load 26–41, non-deterministic harness) are superseded by these two and are not
repeated.

**Desktop app, one window, nothing changing, 4 simulated hours. Spawns in hours 1 / 2 / 3 / 4.**

| Scenario | Before | After | Hour 4 request lower bound (auth × 3), before → after | Source |
| --- | --- | --- | --- | --- |
| GHES, 10 rows, focused | 731 / 717 / 717 / 723 | 156 / 44 / 36 / **42** | 787 → 62 | m4-air, D3 harness |
| | 746 / 738 / 735 / 741 | 151 / 52 / 36 / **36** | 805 → 54 | local, D3r harness |
| GHES, 10 rows, visible but unfocused | 731 / 717 / 717 / 726 | 76 / 15 / 10 / **10** | 790 → 14 | m4-air, D3 harness |
| | not run | 80 / 10 / 10 / **10** | 14 | local, D3r harness |
| GHES, 10 rows, 20% of linked PRs with CI that never finishes | 728 / 723 / 714 / 723 | 256 / 43 / 37 / **37** | 787 → 55 | m4-air, D3 harness |
| | not run | 254 / 45 / 37 / **37** | 55 | local, D3r harness |
| GHES, 50 rows, focused | 831 / 834 / 833 / 818 | 710 / 157 / 157 / **157** | 1,058 → 239 | m4-air, D3 harness |
| GHES, 50 rows, unfocused | 831 / 834 / 833 / 818 | 211 / 10 / 10 / **15** | 1,058 → 21 | m4-air, D3 harness |
| github.com, 10 rows, focused | 362 / 362 / 362 / 363 | 58 / 14 / 13 / **14** | 363 → 14; `rate_limit` probes 91 → 1 (modelled reuse, §4.5) | m4-air, D3 harness |
| | 364 / 364 / 363 / 364 | 57 / 15 / 13 / **13** | 364 → 13; probes 90 → 1 | local, D3r harness |
| github.com, 50 rows, focused | 361 / 362 / 362 / 362 | 232 / 49 / 50 / **50** | 362 → 50 | m4-air, D3 harness |

**D3 said "717 → 36" for the GHES warm hour. Correct statement: hours 2–4 after the change are 44 / 36 / 42 on m4-air
and 52 / 36 / 36 locally; a single warm hour is 36–42 at 10 rows.** With intervals of 30 and 60 minutes the count of
one hour depends on where the reads fall, so the series is the figure, not one hour. The first hour is the cold
start plus the ladder (a visible row is read 6 times in its first 62 minutes). At 50 rows the first hour is
budget-bound (710 spawns against "before" 831), as D3 predicted; from hour 2 it is 157.
Hidden: 0 spawns before and after (m4-air). Return after 30 minutes away: catch-up burst 75 s at 10 rows, 200 s at 50
(m4-air, D3 harness).

**Serve path, github.com, 2 contract clients started 25 s apart unless named.**

| Scenario | Spawns per hour | Notes | Source |
| --- | --- | --- | --- |
| Before, 14 rows, 20% running CI, 4 h | 729 / 597 / 399 / 380 | 2,672 client calls; up to 72 starts in 5 min, 28 in 60 s | m4-air, D3 harness |
| | **751 / 745 / 745 / 741** | same 72 and 28. **See the note below: this, not 380, is "before" for two clients that are out of phase** | local, D3r harness |
| After, same | 107 / 23 / 17 / **16** | 138 upstream starts; ≤ 18 in any 5 min, ≤ 8 in 60 s; 0 client failures in 405 calls | m4-air, D3 harness |
| | 108 / 21 / 18 / **16** | 138 starts; ≤ 18 and ≤ 8; 0 failures in 401 calls; longest reply 0.8 s simulated; selected row at its 30 min cap (largest gap 1,783 s) | local, D3r harness |
| After, 14 rows, all settled | 68 / 21 / 19 / **18** (before 731 / 670 / 418 / 377) | 0 failures in 307 calls | m4-air, D3 harness |
| | 68 / 21 / 19 / **16** | 0 failures in 305 calls | local, D3r harness |
| After, GHES, 14 rows | 322 / 61 / 57 / **49** (before 1,652 / 1,140 / 1,110 / 1,127) | request lower bound hour 4: 1,197 → 73 | m4-air, D3 harness |
| After, 10 rows, 3 clients | 85 / 15 / 13 / **12** (before 839 / 820 / 652 / 607) | | m4-air, D3 harness |
| After, 50 rows, 3 clients | 211 / 76 / 50 / **52** (before 3,793 / 3,761) | 0 failures in 2,383 calls | m4-air, D3 harness |
| After, 200 rows, 1 client | 212 / 211 / 217 / **217** (before 4,958 / 4,918) | Budget-bound for all four hours: 200 rows never reach a warm state inside 4 h. 0 failures in 4,028 calls | m4-air, D3 harness |
| After, clients unfocused (pause) | 32 / 4 / 4 / **4** | | m4-air, D3 harness |
| After, every third PR read takes 25 s, 2 h | 105 / 20 | 68 replies cut at the 10 s deadline; **no reply over 10 s**; 0 failures in 412 calls. m4-air: 70 cut, 0 over, 0 of 422; at 50 rows 223 cut, 0 over, 0 of 2,328; reads of 45 s (longer than the client's 30 s deadline): 78 cut, 0 over, 0 of 411 | local, D3r harness; m4-air, D3 harness |
| After, clients hidden, 1 h | 5 | 3 upstream starts in minute 0, none in minutes 1–59 (both sources) | both |
| After, 50 rows, 3 clients, all vanish at minute 30 | 110 / 0 | **0 upstream starts after the clients were gone** | m4-air, D3 harness |
| Legacy clients (no `selected`) on the new host, 2 h | 379 / 375 | **0 client failures** in 1,340 calls; 301 answers reused inside 60 s, 670 upstream reads, gate untouched | m4-air, D3 harness |
| | 384 / 382 | 0 failures in 1,342 calls; 505 reused, 671 upstream reads, gate untouched | local, D3r harness |

**Note on "before" (D3r correction).** In the D3 harness the "before" serve cost fell from 729 to 380 over four
hours, and D3 left that "not investigated". It was the timing artefact of §1.1 finding 4: the two clients, started
25 s apart, drifted into phase, and once their reads overlapped `runHostedPRRead` coalesced them. With deterministic
timing they stay 25 s apart and every read is its own: 741–751 per hour, flat. Both are real "before" states (clients
in phase: about 380; out of phase: about 745); production sits wherever its clients happen to be. The honest range
for the reduction at 14 rows and 2 clients is therefore **380–745 → 16–18**. The same caution applies to every
"before" serve figure from m4-air in the table above (they are lower bounds for out-of-phase clients). The "after"
figures do not depend on phase because the store answers the second client.

**Disconnect (D3r).** 20 rows, 3 clients (one with 5 private rows), client 1 vanishes at minute 15, 1.5 h, against
the same line without the disconnect (measured, local, D3r harness): 0 client failures in 417 calls. Host queue age
(the longest any start had waited since its first refusal) per 5-minute window, from minute 20:
disconnect `150, 146, 29, 10, 10, 0, 0, 0, 0, 20, 0, 0, 0, 0` s; no disconnect: the same fourteen numbers.
The disconnect cost nothing measurable: client 2 asks for the same rows and takes over the vanished client's place in
the queue. Per client the series is *not* the same (client 2 has no starts of its own while client 1 is there, and
inherits all of them afterwards), which is why the rule in §15 is on the host series. The 50-row version
(`cancel-disconnect20-n50-c3`) ran on m4-air with the D3 harness, which had no time series: not decided there.

**Lanes through the real scheduler and host path.** Clients each select a different PR with running CI; "checks" adds
a Checks-panel read per client. Bound for R rows: `5 min × ceil((R + 5) / 15)`.

| Scenario | Gate | Visible identities never served | Worst visible wait (bound) | Selected starts (own + borrowed) | Per selected identity: worst gap | Peaks: budgeted per 5 min, per 60 s | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 14 rows, 2 clients on the same PR, checks (2 identities), 3 h | D3 | 0 | **171 s** (600) | 178 + 163 | 189–239 s | 20, 8 | m4-air; local identical |
| 14 rows, 2 selected PRs, checks (4 identities), 3 h | D3 | 0 | **215 s** (600) | 180 + 168 | 240–290 s | 20, 10 | m4-air; local 215 s |
| 20 rows, 4 selected PRs, checks (8 identities), 3 h | D3 | 0 | **347 s** (600) | 180 + 156 | 310–500 s | 20, 11 | m4-air, D3 harness |
| | D3 | 0 | **385 s** (600) | 180 + 155 | 341–550 s | 20, 11 | local, D3r harness |
| 30 rows, 4 selected PRs, 1.5 h | D2 | **9 of 30** | not served in 90 min | 343 + 0 | 165–200 s | 20, 10 | local, D3r harness |
| | D3 | 0 | **471 s** (900) | 90 + 55 | 275–295 s | 20, 10 | local, D3r harness |
| 30 rows, 4 selected PRs, checks (8 identities), 1.5 h | D2 | **14 of 30** | not served | 351 + 0 | 230–280 s | 20, 14 | local, D3r harness |
| | D3 | 0 | **492 s** (900) | 90 + 51 | 442–575 s | 20, 11 | local, D3r harness |
| 50 rows, 4 selected PRs, 3 h | D2 | **29 of 50** | not served in 3 h | 697 + 0 | 154–210 s | 20, 10 | m4-air, D3 harness |
| | D3 | 0 | **900 s** (1,200) | 181 + 112 | 280–295 s | 20, 10 | m4-air, D3 harness |
| 50 rows, 4 selected PRs, checks (8 identities), 3 h | D2 | **34 of 50** | not served | 711 + 0 | 230–280 s | 20, 14 | m4-air, D3 harness |
| | D3 | 0 | **910 s** (1,200) | 180 + 110 | 570–585 s | 20, 11 | m4-air, D3 harness |
| 50 rows, 2 selected PRs, 3 h | D2 | 0 | 2,020 s | 354 + 0 | 93–117 s | 20, 8 | m4-air, D3 harness |
| | D3 | 0 | **920 s** (1,200) | 178 + 109 | 215–223 s | 20, 8 | m4-air, D3 harness |
| 50 rows, 2 clients on the same PR, checks, 3 h | D3 | 0 | **942 s** (1,200) | 180 + 107 | 230–239 s | 20, 8 | m4-air, D3 harness |
| 50 rows, 4 selected PRs, a foreground read per client every 8 s, 2 h | D3 | 0 | **900 s** (1,200) | 120 + 59 | 16 s | 20, 11 (interactive lane on top: 114 per 5 min, 24 per 60 s) | m4-air, D3 harness |

**D3 said "worst visible wait 471–491 s". That is the 30-row scenario. The worst visible wait by size is: 171–215 s
at 14 rows, 347–385 s at 20, 471–492 s at 30, 900–942 s at 50; every one is inside its bound.** Client failures: 0 in
every lanes run. The right-hand columns are the trade-off of §3.3: with four clients each watching a different
running PR, D3 reads each about every 100 s instead of every 60 s (worst gap about 290 s), and about every 5 minutes
(worst gap about 580 s) when every client also has the Checks panel open.

**Detection**: the tables in §3.3. Cost while CI events happen (3 PRs cycling, 8 h, local, D3r harness): desktop GHES
62–120 spawns per hour against 739 before; serve 39–52 against 744. On m4-air (24 h, D3 harness): 97–111 against 723,
and 37–44 against 405.

### 6.3 What these numbers do and do not support

- They support: the direction and rough size of the reduction for 10–14 rows; the lane bounds; zero client failures
  with the contract; the reply deadline; zero reads with zero clients; legacy clients keep working.
- They support (D3r, from m4-air): cost and lane bounds at 50 rows, and that 200 rows stay budget-bound.
- They do not support any claim about multi-window desktops, a real GHES host, errors, or CPU; and nothing above 30
  rows or 8 simulated hours has been run on the deterministic harness. An "idle desktop" figure is supported only for this workload: one window, one selected row, Checks
  panel closed, no watches, no errors: **10 spawns per hour at 10 worktrees (measured, both sources), request lower bound 14.**
  With the Checks panel open on a PR whose checks are running, add its reads (about 60 per hour, modelled). Each
  additional window adds its own selected row.
- "N clients cost the same as one" holds for clients that request identical read identities through the contract. It
  excludes legacy clients, interactive reads and rows only one client sees.

## 7. Peaks

- Serve, budgeted lanes: the table in §4.4. Per lane, not universal.
- A GHES refresh is 3–4 spawns in the same second, so the spawn peak per rolling minute is a multiple of the start
  peak. Measured values are in §6.2 (`pk60`).
- "Peak in any minute ≤ 2 × the 15-minute mean" stays rejected as a criterion (D2 §8): the ratio rises because the
  mean falls. The local runs show 15 for every warm "after" scenario, where one refresh per many minutes is the whole load.
- Jitter is kept at 10% for the reason in §3.1 and is not relied on for peaks.

## 8. Disposition of Neil's D2 findings

Every finding is accepted. "Resolution" is a design change, to be verified in implementation.

| ID | Sev | Decision | Resolution in D3 | Evidence, with label |
| --- | --- | --- | --- | --- |
| D2-1 retained `nextRefreshAt` keeps a timer after the row has no timed interval | P2 | Fix | §4.3: no-timer precedence in `dueAt`; hints bound to epoch and basis; late replies cannot reinstall; discovery / foreground / manual exceptions kept; state transitions in §4.6 | measured (local probe): D2 patch fires at +300 s and +200 s, D3 patch makes no call; hint-store cases. In the harness the capable client uses the D3 patch and the hint store. Cadence-specific cases no longer exist |
| D2-2 selected reads can take the whole gate | P2 | Fix; product decision "visible staleness stays bounded" applied | §4.4 lanes: visible 15, selected 5, borrow ≤ 5 only while no visible claim is live; bound `5 min × ceil((R+5)/15)`; per-lane peaks; the "six per minute" claim withdrawn; same rule for the desktop pacing | measured (local probe): 0 of 50 → 50 of 50 with 4 and with 8 selected identities; bounds asserted. measured (local harness, reduced size): §6.2. **m4-air run required** (§15 group D). Desktop pacing: not prototyped |
| D2-3 complete empty rollup classified as running | P2 | Fix | §4.2 activity classes; `checksFinal` untouched; failed + running and awaiting approval stay running; incomplete stays running | measured (local probe) with the real classifier: open no-CI 30 / 60 min, merged no-CI no timed read. The harness world now has no-CI rows |
| D2-4 header-fed state leaves expired / unseen resources unprotected | P2 | Fix (narrowed as the critique asked: proactive floor, not a bypass of the breaker) | §4.5 per-resource freshness; one scoped, coalesced refresh, ≤ 1 per scope per 60 s, before a headerless background read of an unknown or expired resource; fail open on failure; older-window and pre-switch observations ignored | measured (local probe) **on a prototype model**: 100 admitted → 11, 1 probe; mixed-resource and failure cases. Real header parsing, account isolation and the WSL / native fallback: not implemented, not measured |
| D2-5 auth arithmetic; scope of claims | P3 | Fix | §2.1: 2 extra requests per counted spawn; tables are spawn counts with a request lower bound; idle and peak claims scoped to the measured workload (§6.3) | arithmetic; the 3-request shape was measured once on github.com with two logins and not on GHES |
| G1 broader auth-inventory reuse | n/a | **Rejected; out of A–E** | §12 | Neil's reason recorded |
| m4-air run of the final gate | evidence gate | Run once on the D3 harness; rerun required on the D3r harness | Lanes, timeouts, cancellation, cost: every decidable rule passed (m4-air, D3 harness). Detection and the disconnect rule were not decidable there; D3r makes them decidable (§1, §15) | Rerun list in §15. Blocks convergence |

Neil's harness-correspondence notes from D2-R4 (private report), each now true of the harness: the interactive lane
enforces 3 per 30 s per client with overflow into the selected lane; the reply deadline is implemented for initiator and
joiner; legacy requests do not touch the gate. Still not true, and stated in §16: the harness key has no account,
generation or runtime dimension; the desktop backoff prototype is keyed by `refreshKey`, not the full identity.

## 9. D1 rows still open

| ID | Status after D3 |
| --- | --- |
| A1 / F1 non-blocking serve admission | Design closed in §4.4 including the cold in-flight timeout reply and the initiator exceeding the deadline. Evidence: local harness, small (§6.2); m4-air pending |
| A2 / F7 identity, null HEAD, narrowed reads | Design unchanged from D2 §4.1. Account / generation / fallback variants and ordering after eviction are test-matrix items; no execution evidence |
| A3 / F8 completion, signature | Closed for empty rollups (D2-3). The signature cannot see queued → in progress; the claim is narrowed in §4.2 |
| A4 / F2 real timestamp, success rule | Closed with D2-1. Implementation must carry RPC success and hints through the fetch actions per request identity, also when an equal `fetchedAt` is deliberately not written |
| A5 / F3 freshness vs budget, selection | Closed with D2-2 for the serve gate. Foreground behind a full budget: in the harness (`lanes-fg-*`), not yet run at size |
| A6 / F9 header scope and ordering | Closed in design with D2-4; older-window rejection and credential-change fencing now explicit. No implementation evidence. An ambient `gh auth switch` can only be detected, not prevented; the scope is cleared when detected |
| F5 peaks, fairness, queue ages | Per-lane bounds in §4.4; desktop queue ages still not instrumented |
| F6 visibility ownership, multi-window | Design unchanged. One window in the harness; multi-window not exercised |
| F10 cost evidence, Linux CPU, errors | GHES spawn counts local and small (§6.2). Linux CPU per spawn, real GHES, upstream errors: open (§16) |

## 10. Requirements carried from #40541 C4

| ID | Requirement | Where met | Test |
| --- | --- | --- | --- |
| R-C4-1 | A stale or failed completion for identity A never clears the pending discovery or intent of a newer identity B | §4.7 | measured (local probe `scheduler-d3`): B read at 10 s instead of 63 s. Main-queue twin: in the matrix |
| R-C4-2 | A removed or reset retry / backoff state takes its `backgroundNotBefore` deadline with it; only real rate-limit and manual gates delay re-exposure | §4.6, §4.7 | In the matrix, with Neil's probe numbers as the failing-first case. Not run in D3 |
| R-C4-3 | All foreground return paths schedule a refresh: priority-80 enqueues are never dropped without re-exposure; paired and stopped targets meet the stated freshness (60 s, one constant); focus-only return counts | §3.2, §4.7 | (b), (c) measured (local probe). (a) in the matrix. Native OS focus events: not tested |
| R-C4-5 | Foreground / age classification uses the injected clock; no negative ages | §4.7 | In the matrix: mobile replay with pinned clock. Not run |
| R-C4-7 | Mobile does not show "Live" while its polling is paused or backed off; copy pending UX | §4.7 | In the matrix: state derived from the armed timer. No phone render |
| Queued watches | A queued entry never keeps a due time from an interval no longer in force | §4.2 | In the matrix (follow-ups, error retries, current-head and earlier-head watches) |
| C4-4 | Tests respect the TS project boundary | §4.7 | Placement rule in §13 |
| C4-6 | Settings-write fencing | none: no setting exists | n/a |

## 11. User-visible effects

- No new control, flag or `orca.yaml` key. Nothing in Settings.
- Selected worktree: checks within about a minute while CI runs; up to 30 minutes for an outside change when nothing
  had changed for half an hour; at once on selection, push, manual refresh, and on returning to the window if the data
  is older than a minute.
- Other visible cards: 2 minutes while CI runs; up to 60 minutes when unchanged (today 2 minutes, or later when the
  budget is full).
- **D3r, measured: a CI run that somebody or something else starts and that ends before the row's next read is never
  shown as running.** On a card that had been unchanged for an hour, 4–7 of 10 outside runs of 20–30 minutes went
  unseen; on the selected worktree, 0–2 of 5. The result of such a run shows at the next read (§3.3). Runs the user
  starts from Orca, or by pushing from the worktree, are not affected.
- After 5 minutes without a focused Orca window only the selected worktree keeps refreshing.
- Wherever Orca shows that data is being refreshed (the phone's "Live" badge, any "updated … ago" text), the state must
  be truthful under backoff and pause. **All copy for backoff and pause: pending UX.** D3 specifies the states, not the words.
- Several windows or paired clients on one host see the same answer and cost one read.

## 12. Rejected and alternatives

- **G1: reuse the GHES `gh auth status` answer across worktrees (key without `cwd`). Rejected by the security owner
  (Neil); not part of A–E.** His reason: the execution scope deliberately includes `cwd`, environment, wrapper and
  credential selection, and the host inventory is part of the trust boundary that keeps an untrusted host from
  receiving ambient tokens. Account binding does not make the inventory account-specific (bound-token injection is
  skipped for `auth` commands), and refreshing after an auth error is too late for the first request. The cost stays:
  4 auth probes per GHES worktree per hour while it is being refreshed. It could return only with a proven
  cwd-invariant credential identity and its own security review.
- **A user setting (#40541).** Closed by owner decision.
- **Alternative lane split: 10 selected / 10 visible, no borrowing** (measured, local probe, same scenarios): two
  selected identities keep 60 s always, but visible-only saturation is one third slower (200 rows: 5,790 s instead of
  3,940 s) and unused selected starts are wasted when one row is selected. Not proposed; shown for Q1.
- **A selected allowance per client** (each client gets its own 5 starts per 5 minutes): keeps 60 s for every
  client's one selected PR, at a host bound that grows with clients (15 + 5 per client). Not measured. Q1.
- Awaitable coordinator with a deadline for serve reads; restamping `fetchedAt`; host-side selection leases; batching
  many PRs per GraphQL query; a sidebar GraphQL query for GHES; avoiding the `gh` process: as in D2 §17, unchanged.

## 13. Test matrix (implementation)

Unit, vitest with fake timers and a mocked `gh-exec-file`. Scheduler tests live in the renderer project; host tests
import no renderer code (C4-4).

| Area | Cases |
| --- | --- |
| Store (A) | slot per identity: account, generation, HEAD, linked, fallback, accept-merged each miss independently and do not evict each other; null HEAD resolved, unresolvable HEAD not served; narrowed read (`checkPageLimit`, `exactRepository`, `includeDerivedData: false`) neither seeds nor wipes; error never stored; older-started later-settled read loses, also after eviction; LRU bound; legacy request reuses only inside 60 s |
| Policy (B) | ladders `[1,2,4,8,16,30]` and `[2,4,8,16,32,60]`; no-PR and closed `[15,30,60]`; selected running never backs off; activity table of §4.2 for open and merged, including complete-empty, incomplete-empty, failed + running, awaiting approval, missing `checksSummary`; unknown mergeability ≤ 10 min; stuck check decays after 30 min on non-selected only; signature resets on failing-name change, count change, review decision; restart on selection, manual, push, HEAD, generation; **no restart on foreground return**; jitter never lengthens; state survives `visibility.update` / `report` and two windows |
| Retime | every interval change (backoff step, running ↔ settled, pause enter / leave, selection) recomputes the due time of queued visible follow-ups, error retries, current-head watches and earlier-head watches; an entry whose interval became "none" is removed together with its deadline (R-C4-2); a real rate-limit deadline and the request-started cooldown survive |
| Client contract (D2-1) | no-timer precedence with a hint outstanding (successful cache; cold deferred); hint paces a timed target; hint retired on identity change, selection change, pause enter / leave, reconnect, newer data from another path; late reply from an older epoch installs nothing but its data is applied; explicit `null`; reused answer and `deferred` are successes; legacy request never receives `deferred` or a hint; `selected` evaluated per request with two clients disagreeing |
| Gate (C, D2-2) | the eight caller mixes of the probe with the bounds asserted; 20 selected at one instant → 6; 4 selected then 16 visible → 15; borrowing stops on a live visible claim and resumes after it; most overdue first inside each lane; work-conserving when the top claimant is absent; claim expiry after disconnect, cancel, hidden; zero clients → zero timed reads; interactive 3 per 30 s then selected lane; manual never gated; legacy never gated; reply deadline for initiator and joiner, with and without an entry; a read slower than the client deadline is stored and served on the next ask; start not refunded; guard-blocked scope refused with `nextRefreshAt = reset` |
| Desktop pacing | the share rule with 1, 2 and 4 windows selecting different rows; visible rows keep ≥ 10 starts per window |
| Rate limit (D, D2-4) | parse headers from REST and GraphQL `--include`, success, 304 and error stdout; per account / host / runtime isolation (bound + unbound, WSL, GHES); min within a window; reset rollover; older-window observation ignored; observation from before a credential change ignored; expired resource + headerless reads → one refresh then the floor; fresh `core` + unknown `graphql`; header-bearing traffic never probes; refresh coalesced; ≤ 1 attempt per 60 s; refresh failure and 5 s timeout fail open; interactive never waits; no double debit; forced probe from Settings; secondary-limit path unchanged |
| Pause (E) | blur 5 min pauses non-selected rows, selected continues; focus re-exposes, selected first; two windows, one focused, is not paused; hidden unchanged; paired client flips `selectedOnly` and drops hints |
| Foreground (R-C4-3, R-C4-5) | priority-80 enqueue with a non-finite interval and no `reexposed` flag creates an entry when data is older than 60 s; paired scheduler: selected stopped target and selected hinted target read on return when older than 60 s, not when younger; focus-only return on both hooks; non-selected stopped target only when older than 15 min; classification with an injected clock, `lastForegroundAt = null` at start, clock moved backwards → not foreground; mobile replay `pr-sidebar-revisit-and-refresh` |
| Stale completions (R-C4-1) | scheduler: A in flight, identity becomes B, A fails / succeeds / is cancelled → B read at cooldown, no failure charged; main queue: same with request sequences |
| Mobile state (R-C4-7) | `live` only while a timed read is armed within the base interval and the last read succeeded; `backed-off`; `paused`; never `live` with no timer |
| Checks RPC | own store entry; selected lane; push (new head) always reads |

Harness: rerun `specs3.txt` on the implementation branch with the real gate.

Live, required before a readiness claim (Neil's separate gate): one real GHES repository on the desktop app with
request counts from the server or `GH_DEBUG=api`, including the `gh auth status` request count; one Linux `orca serve`
with 14 worktrees and 2 clients sampled with the reporter's `/proc` method before and after; one paired phone
foreground / return cycle; one mixed-version pair (old client, new host).

## 14. Implementation plan

No prerequisite PR any more. Order: **PR 1 (D) → PR 2 (A + B + C + E, the client contract, foreground and queue hygiene)**.

- **PR 1: per-resource rate-limit state.** `rate-limit.ts`, `github-rest-revalidation.ts`, the GraphQL readers, the
  breaker scope key gains the account, the scoped refresh. No freshness change. Removes most of the 84–91 probes per
  hour on github.com desktops.
- **PR 2.** One PR because the pieces are not safe apart (B without the client contract makes reused answers look like
  failures on paired clients; C without A has nothing to answer from). Salvage from the closed #40541 branch:
  the paced store shape, `pacedPRChecksKey`, the `foreground` flag plumbing, `retimePRRefreshes…` (generalised to
  §4.2's rule) and their tests, minus all cadence code.
  1. Store: full-identity slots, HEAD resolution, narrowed reads out, ordering.
  2. Policy: shared activity function and interval function in `review-refresh-policy.ts`; host backoff state; retime.
  3. RPC and gate: `selected`, `foreground`, `nextRefreshAt`, `deferred`, the lanes gate, the reply deadline.
  4. Desktop pacing share rule.
  5. Renderer: success rule, `dueAt` order, hint store, `selectedOnly` on pause, focus listeners, stale-completion
     rule. Main queue: R-C4-1, R-C4-2, R-C4-3(a).
  6. Mobile: `selected` / `foreground`, injected clock, truthful state.
  If it must be split, the only safe cut is desktop-only B + E + queue hygiene first (no RPC change), then the serve half.

## 15. m4-air rerun list (required before D3r can converge)

Pinned commit and hashes: §17. Instructions with the exact commands: `src/main/github/__experiments__/RUN.md` on the
harness branch. Every rule below is computed by `verdict3r.py` (one PASS / FAIL / REPORT line per rule per scenario,
exit code 1 on any FAIL); nothing is judged by hand.

1. **Fast probes** (4 files, 17 tests): must all pass, otherwise stop.
2. **Determinism gate**: `specs3r-local.txt` (45 small scenarios) once, 28 of them a second time. Rule G.
3. **`specs3r.txt`**: the 66 D3 scenarios with unchanged spec lines, plus 28 added. Priority D, E, C, A, B, H, F.
4. **Rerun** three full-size scenarios into `results/rerun/` (rule G).

| Group | Scenarios | Passes if (all computed) |
| --- | --- | --- |
| G determinism (new) | `results/local2/`, `results/rerun/`, `local-digests.txt` | A second run of a spec line has the same `determinism.spawnDigest`, the same `gh` block, lane summary and detection report as the first (a differing `gateDigest` alone means per-client attribution of a tie and is reported, §1.4). The 45 local scenarios have the digests recorded on the authoring Mac; if they differ but m4-air agrees with itself, report it (Node version) and continue |
| D lanes (11 + 4) | `lanes-*-gate-d2` / `-gate-d3` | Unchanged from D3. On `gate-d3`: `visibleIdentities.neverServed = 0`; visible `peak5min ≤ 15`, selected `≤ 10`, budgeted `≤ 20`, budgeted `peak60s ≤ 11`; visible `waitedS.max ≤ 5 min × ceil((R+5)/15)`, R = `EXP_N`. `gate-d2` rows and every selected identity's `maxGapS` are reported. Added: the four 30-row scenarios |
| E timeouts, cancellation (6 + 3) | `timeout-*`, `cancel-*` | `rpcSimulatedMs.over10s = 0`; `clientFailures = 0`; `replyDeadlineHits > 0` in the slow runs; `upstreamStartsAfterAllClientsGone = 0`; `cancel-hidden`: 0 spawns after minute 0. **Disconnect (redefined):** let `age(w)` be the largest queue age (time from a start's first refusal to the start) among starts in 5-minute window `w`. For every window that begins at least 5 minutes after the disconnect, `age(w)` over the clients that are left ≤ `age(w)` over all clients in the paired run without the disconnect (`cancel-ref-*`) + 15 s (the claim grace) |
| C serve cost (17) | `serve-*` | Unchanged: `clientFailures = 0`; `serve-oldclient`: 0 failures and no gate admits. Spawns per hour reported |
| A, B desktop (24) | `ghes-desk-*`, `dotcom-desk-*` | Unchanged: `hidden` = 0 spawns. Hours 1–4, auth spawns, request lower bound reported |
| H cap options (new, 9) | `capcost-*` | Report only: spawns in hours 1–4, for PD-1 |
| F detection (8 + 12, 24 h each) | `detect-*` | For each "after" scenario, over every (event, observer) pair, on `latency − slot wait`: **F1** a finish of a run that observer had seen running ≤ 70 s (selected) / 130 s (not selected); **F1b** the same on a non-selected row seen running and unchanged for ≥ 30 min ≤ the stuck-ladder interval + 10 s; **F2** every other pair (a start seen running; the first read after a run that was never seen running; the finish of such a run) ≤ cap + 10 s (1,810 / 3,610 s at the contract caps); **F3** `uncovered = 0`: no pair without a read after the event, except events in the last cap + 25 min of the run (`pendingAtEnd`). Reported, not judged: how many runs were never shown as running, and the worst slot wait. "Before" and legacy scenarios are report only |

Slot wait is recorded per detection: on the serve path the time from the first gate refusal to the start of the read
that brought the data (the larger of the host's and that client's own); on the desktop the time from the policy's due
time to the first `gh` spawn of that read. A slot wait itself is bounded by rule D, not by F.

**Local result of the same rules** (measured, local, D3r harness, `specs3r-local.txt`): 45 scenarios, 90 rule lines
PASS, 0 FAIL; with the rerun and the digest file 143 PASS, 0 FAIL. F1 / F1b / F2 / F3 pass in all 15 "after" detection runs; D passes at 14, 20 and 30 rows; the
disconnect rule passes at 20 rows.

Durations: on m4-air the D3 list took 768 s of wall time at parallel 4 (19–56 s per scenario). The D3r stepping costs
more real event-loop turns: locally vitest reported 3.6–6.8 s for the 4 h scenarios and 25 s for an 8 h detection run
(D3: 5.8 s for 24 h on m4-air), so expect the twenty 24 h detection runs to take a few minutes each. Not measured on
m4-air. Local wall times at parallel 2 were 37–60 s per scenario, with one pair at 1,428 s while the machine was at
load 50.

## 16. Evidence gaps

1. **The D3r harness has not run on m4-air.** Its numbers are 45 scenarios of 10–30 rows and at most 8 simulated
   hours. Everything at 50 and 200 rows and every 24 h figure is from the D3 harness, which was not reproducible.
2. **Detection at 24 h with classes and slot wait is not measured.** The m4-air detection figures are pooled
   (§1.1). The class split is measured only at 8 h and 10–14 rows, where slot wait never exceeded 14 s; detection
   with a saturated budget (50 rows, where slot wait reaches 900 s) has no scenario.
2a. **"Before" on the serve path depends on client phase** (§6.2 note): 380 or 745 at 14 rows. No scenario sweeps the
   phase; the m4-air "before" serve figures are from the non-deterministic harness.
2b. **The disconnect rule is measured at 20 rows only.**
2c. **PD-1 costs are measured at 10 rows, 4 h, one window, locally.** The 50-row cost lines are on the list, not run.
3. **Desktop pacing lanes** are specified, not prototyped. Multi-window starvation on the desktop was not reproduced;
   it follows from arithmetic.
4. **D (rate limit)** is a model. No header parsing, no account isolation, no WSL / native fallback, no real 403.
5. **Harness simplifications**: one account, one generation, one runtime in the store key; desktop backoff keyed by
   `refreshKey`; the Checks read is modelled; one desktop window; no upstream errors; no watches; no real transport;
   no phone.
6. **R-C4-2, R-C4-3(a), R-C4-5, R-C4-7 and the queued-watch rule** are requirements with specified tests; none was run.
   Native OS focus events were not tested.
7. **Spawn = request** was verified on github.com with gh 2.103.3 only. `gh auth status` = 3 requests on one two-login
   machine. No real GHES host was queried.
8. **Linux CPU per spawn (F10)**: still open; no reporter box.
9. Polling paths were not re-diffed against `origin/main` `0b838946967`.
10. The D3r document is published as an Orca artifact (private link, in the completion report); nothing was posted
    to GitHub or Slack.
11. Effective reasoning effort of the authoring model is not exposed.

## 17. Freeze record

- Document: this file. Its sha256 is recorded next to it in `sta-8667-d3r-results/SHA256SUMS.txt` and in the
  completion message (a file cannot contain its own hash). Frozen D3, which this replaces: sha256
  `ae144e28d0a81b55de8642e6d930c1c17a1f1f195a1093d0e222ab6abb227cac`.
- Harness: branch `AmethystLiang/sta-8667-polling-harness`, **D3r commit
  `51a148903433b01fb7a8064bf55550a4abca7fa9`**, parent `586c55387eb` (the D3 harness that ran on m4-air), based on
  `9f32c6d06dd`. Committed with git plumbing: the repository's commit hooks and lint did not run on it. Pushed. No PR.
  Never merge.
- Harness file hashes (sha256), also in `sta-8667-d3r-results/HARNESS-SHA256.txt`. Unchanged since D3: `gate-d3.ts`,
  `scheduler-patches.ts`, `rate-limit-d3.ts`, the four probe files, `specs3.txt`.

  | File | sha256 |
  | --- | --- |
  | `gate-d3.ts` | `5c45d14449fe5e39b335bb533318278a5ec700beb14672207c3614410223bf60` |
  | `gate-lanes.probe.test.ts` | `3bf47e88454fce54cf0fe0d0a5d24d8185d7ca6f111fffd2caf39d54fcb66003` |
  | `policy-d3.probe.test.ts` | `34216e0debfc932bffe9d0088ec1d1bed4fb02d862caac8ee7c127741caf8fe8` |
  | `policy-d3.ts` | `c66c71fa90890b6a033ab3edea9ce439c983dc1e1d06a0e5b4b262603a2e60df` |
  | `polling-cost.experiment.test.ts` | `80c3e14a98cd2597738b4d97a40157f6ccf5b2870aca49b0a47b2279dba946ff` |
  | `polling-d2.experiment.test.ts` | `266111b5507b2a0edd4785111ac4d6d64a99b394605969d79079fb1581d868ae` |
  | `rate-limit-d3.probe.test.ts` | `bc8a2cb6cd294793275312ab413b8e6ce8deef940b303a1618d8a65db59a8c7a` |
  | `rate-limit-d3.ts` | `4685190159987701f9f81c9c15e7526bb83eafa0ba43fef595cb65e4ca5e4a8a` |
  | `scheduler-d3.probe.test.ts` | `bab4308d877d0de403f6655b8edb0ed6bd257fd27cd6b3e29fcee5cc657d9edd` |
  | `scheduler-patches.ts` | `9cb1ce015076b19d7dd05c38e826563021392bf822dfed8dc07a00a17d2592bd` |
  | `specs3r.txt` | `9071a49a501b33f520154ec0f6f22227f0be67ca4c151a32fd95c3dbae4a9dd1` |
  | `specs3r-local.txt` | `1359840135199ee4c356155859945a7d82ff717e8e9250cee9cecdfcfcef9c26` |
  | `local-digests.txt` | `1c66b8818ac1aac7c099f41181914f3b2f07e4387519125291858e5b8a3b55b1` |
  | `run-specs.sh` | `632825aa0c656f739447e6052a948db1bb593a0b79c6d94811d5d64d5c40de92` |
  | `table3.py` | `3ee402bf0f15bf8644c39eccb23c7a4ef686319ea1187c475dcc37de20797293` |
  | `verdict3r.py` | `870233d3b7bbe2516fd26ee4989efbd19f459ca80c604d8e80570497a51fbcc4` |
  | `RUN.md` | `dca64fe5ef0ce23e3ca675a40cf8385de5f609e19701b6864b28048351b26645` |
  | `specs3.txt` | `096c1608d033cfbbf8dcddadbf3242d07fb951d16b07dd12845f7414e4f42a20` |

- What ran this round, all on the authoring Mac (node v26.10.0, vitest 5.0.5, load average 13–59, parallel 2), all
  on the files hashed above: the four probe files (17 tests, passing); `specs3r-local.txt`, 45 scenarios of 10–30
  rows and at most 8 simulated hours, 45 of 45 with exit code 0 and a JSON; 8 of them a second time; `verdict3r.py`:
  143 PASS, 0 FAIL. Before the final harness edit: one 2 h serve scenario twice on the D3 stepping (the divergence
  quoted in §1.1), a diagnostic run, and two 8 h detection runs; these are not cited as results. Nothing above 30
  rows and nothing of 24 h ran locally. **The D3r harness has not run on m4-air.**
- m4-air evidence cited here is the D3 run: harness `586c55387eb`, results branch
  `AmethystLiang/sta-8667-d3-m4air-results` commit `283af8fe79a003b29c4196ce99228a5ea9be29bc`, report
  `D3-M4AIR-RESULTS.md`.
- Local results: `docs/design/sta-8667-d3r-results/` (`results-local/`, `results-local2/`, logs, `table3-local.txt`,
  `verdict-local.txt`, probes), copied to `~/.orca/bots/perf-manager-2/memory/sta-8667/d3r/`.
- Base commit `9f32c6d06dd`; polling paths not re-diffed against a newer `origin/main` (gap 9); #40541 closed at
  `4a19f563add`. No production file was changed.
- Model: Claude Fable 5.2 (`claude-fable-5-2`); effective effort not exposed to the worker.
- Round: D3 of max D4 (pre-review revision).

## 18. Open questions

1. **Selected lane size (§3.3, §4.4).** The proposal guarantees 60 s for one selected read identity per host and
   lets more borrow only while no visible row is waiting. With several clients watching different running PRs, or
   with Checks panels open, selected rows slow to minutes while visible rows catch up (§6.2). Alternatives with their
   cost are in §12 (10 / 10 split; an allowance per client). Product call for the coordinator.
2. **Caps of 30 and 60 minutes.** Measured now (§3.3). The decision is **PD-1** below; needs UX acceptance either way.
3. **Foreground freshness 60 s** (one constant everywhere) instead of the 10 s #40541 promised under Off. And: a
   window return does not restart the backoff ladder. Both are mine; both keep alt-tabbing from undoing the saving.
4. **Selected + awaiting approval** stays at 60 s without limit. Decay it like a stuck check after 30 minutes?
5. **Desktop pacing lanes** (§4.4): accept specifying the same share rule for `PRRefreshPacing` without a prototype,
   or require one in D4?
6. **Unfocused pause on a second monitor**: non-selected cards stop updating after 5 minutes without focus. UX.
7. **Copy** for backed-off and paused states, desktop and phone: pending UX.

### Product decisions raised by D3r (for the coordinator; the contract is unchanged until decided)

**PD-1. Should the caps be lowered so that fewer outside CI runs go unseen?** The contract stays 30 / 60 minutes in
this document. The m4-air run showed what those caps cost in practice (§3.3): on a card unchanged for an hour, 4–7 of
10 outside runs of 20–30 minutes are never shown as running and their result is up to 40 minutes late; on the
selected worktree 0–2 of 5 are missed and the result is up to about 10 minutes late (measured 139–154 s on serve,
1,167 s for 5–10 minute runs). A run is always seen when it is longer than the cap. Options, all measured (local,
D3r harness, GHES desktop, 10 rows, one window; cost = quiet world, hour 4; "before" is 741):

| Option | Selected / visible cap | Spawns per hour, hours 2–4 | Hour 4 request lower bound | Outside 20–30 min runs never shown (8 h, seed 1): selected / visible | Guarantee gained |
| --- | --- | --- | --- | --- | --- |
| A. D3 contract | 30 / 60 min | 52 / 36 / 36 | 54 | 0 of 5 (seeds 2, 3: 1 and 2 of 5) / 6 of 10 | none |
| B. | 15 / 60 | 56 / 44 / 44 | 62 | 0 of 5 / 5 of 10 | selected: any run ≥ 15 min is seen; any change within 15 min |
| **C. recommended** | **10 / 60** | **71 / 50 / 51** | **71** | **0 of 5 / 5 of 10** | **selected: any run ≥ 10 min is seen; any change within 10 min** |
| D. | 5 / 60 | 81 / 72 / 69 | 89 | 0 of 5 / 5 of 10 | selected: within 5 min (D2's cap) |
| E. | 30 / 30 | 66 / 62 / 62 | 94 | 0 of 5 / 1 of 10 | visible: any run ≥ 30 min is seen |
| F. | 30 / 20 | 94 / 97 / 101 | 153 | 0 of 5 / 0 of 10 | visible: any run ≥ 20 min is seen |
| G. | 10 / 20 | 107 / 106 / 115 | 169 | 0 of 5 / 0 of 10 | both |

The "guarantee gained" column is by construction (a run longer than the interval is read at least once while it
runs). The measured column cannot show it for the selected row, because seed 1 has no selected miss even at 30 min.

The selected cap costs a constant per window (one row): +15 spawns per hour for C at any number of worktrees
(modelled: 4 extra reads × 3 spawns, plus auth). The visible cap costs per visible row: E adds about 26 per hour at
10 rows and F about 65, and both scale with rows (modelled from D3's 157 per hour at 50 rows: about 270 and 440; the
50-row lines are on the m4-air list, not run). Every option is still at least 84% below "before" at 10 rows.
**Recommendation: C.** The selected worktree is the one the user is looking at; 10 minutes covers ordinary CI runs
and costs 15 spawns per hour per window whatever the number of worktrees. Leave the visible cap at 60: that is where
the GHES request saving comes from, and a missed run on a card the user is not looking at costs only the "running"
badge, since the result still arrives within the hour. Not chosen by D3r; a product call.
A different kind of fix, not costed by a run: one batched GraphQL query per repository every 2 minutes for the check
state of all visible PRs (about 30 requests per hour per repository whatever the number of rows, modelled) would show
every start within 130 s. D2 §17 left batching as a follow-up because of its size (per-PR errors, head fencing,
pagination); it remains that.

**PD-2. A finish on a non-selected row whose checks have been running, unchanged, for more than 30 minutes is not
within 130 s.** This is D3's stuck-check rule (§3.1, §4.2): after 30 unchanged minutes the row is read every 4, 8,
16, 32, then 60 minutes, so that a check that never finishes does not cost 30 reads per hour for ever. A single job
longer than 30 minutes looks the same. Its finish is then seen within the ladder interval: up to 4 min late for a
finish at minute 30–40 of the run, 8 at 40–50, 16 at 50–60, 32 at 60–70, 60 after that. Measured (local, D3r harness,
40–50 min runs, serve): 6 such finishes, worst 115 s, bound 490 s; the bound was not approached in this sample.
Options: keep the rule and state the exception (**recommended**; it is now in the §3.3 table); or cap the ladder at
10 minutes (a stuck row then costs 6 reads per hour instead of 1, modelled). The selected row is not affected: it
stays at 60 s while checks run.

