# LLM Counsel Report — `fix-mobile-chat-ui` @ `8cb45318d7`

- Run: `20260726-164449`
- Base: `8cb45318d76db4899e0790f255e56c2c1d37d7f1` (HEAD == origin/main merge-base → **entire branch is uncommitted/staged/untracked working-tree state**, ~+2900/−262 across 42 files)
- Seats: grok | codex gpt-5.6-sol high | claude opus high | claude fable high
- Date: 2026-07-27T00:05:00Z
- Mode: review-only (no production code modified by counsel)

## Executive verdict

**Ship risk: medium — do not merge without fixing at least the stop silent-reject path and the shared-budget last-leg timer hole.** The branch is a large native-chat hardening pass (shared 15s send budgets with `budgetSpansConnect`, rearm-bounded covered streams, prune retention, inline send-error banners, provider-session projection). Core direction is sound and multi-seat verification found green gates (mobile vitest ~1094, desktop suites, tsc/oxlint) where run. Residual risk clusters on (1) **false UX on send/stop outcomes** that invite double-sends or silent failures, (2) **one-shot covered-stream recovery that can stick on a stale-success snapshot**, and (3) **host-side Pi / providerSession projection gaps** under headless serve. Seats agree strongly on stop rejection silence and shared-budget partial-completion class; they disagree on severity inflation (Grok’s two Highs demoted by peers) and on whether multi-write truncation is a regression vs intentional budget product contract.

## Consensus findings

Deduped where ≥2 seats agree **or** one seat with strong evidence the coordinator spot-checked.

### C1. Medium (near-High) — Stop silently ignores resolved non-accepted host replies

- **Severity:** Medium (functionality) — elevates if reminted-handle / #10681 rejection path is common
- **Files:** `mobile/src/session/use-mobile-native-chat-stop.ts` L54–62, L89–103
- **Agreeing seats:** claude-fable (F1), codex (Medium), peer raters all called this A/C’s strongest functional catch; claude-opus missed it
- **Summary:** `then` only sets `sawAccepted ||= isTerminalSendRpcAccepted(response)`. `sawRejected` / `sawUnknown` are set only in `catch`. A resolved `{ok:false}` / non-accepted reply leaves both false → `reportIfSettled` stays quiet forever when neither Escape was accepted.
- **Coordinator spot-check:** **Confirmed.** Lines 89–99 match the claim exactly.
- **Smallest fix:** In the `then` path, if not accepted, treat as rejected (or unknown only if response shape is ambiguous) — same semantics as other native-chat sends. Fable notes the default test mock `{ok:true}` never exercises `send.accepted`, so add a resolved-reject test.

### C2. High/Medium — Shared action budget can arm the final text+Enter write with a sub-second timer → “Delivery unconfirmed” after a delivered frame

- **Severity:** High if multi-image / multi-paste then text is a common path; Medium otherwise
- **Files:** `mobile/src/session/mobile-native-chat-send.ts` L42–61; `mobile/src/session/mobile-native-chat-image-send.ts` L19, L57–74; `mobile/src/transport/rpc-client.ts` L1019–1026 (`Math.max(min(MIN_REQUEST_TIMEOUT_MS, budget), deadline−now)` floor capped by caller ask)
- **Agreeing seats:** claude-opus (High #1), codex (multi-image/answer truncation Mediums), grok (budget overrun Medium), peers rank D’s articulation highest
- **Summary:** Image loop refuses to start a write with `< 2000ms` remaining. Text send only rejects when `timeoutMs <= 0`, so e.g. 400ms remaining still fires `sendRequest` with a 400ms timer. Frame may land; timer marks delivery-unknown → “Delivery unconfirmed” and double-send bait.
- **Coordinator spot-check:** **Confirmed** asymmetry between image min-write floor and text `<=0` guard; transport floor cannot exceed caller budget.
- **Smallest fix:** Apply the same min-write floor (or refuse-to-start when remaining &lt; floor) to the terminating text+Enter leg; optionally surface partial multi-write failure distinctly from “not sent”.

### C3. Medium — Covered-stream tabs recovery can be consumed by an accepted-but-stale snapshot (not by failed fetch)

- **Severity:** Medium
- **Files:** `mobile/src/session/use-mobile-native-chat-terminal-stream.ts` L104–120; session route recovery wiring; `session-tab-snapshot-gate` equal/cached accept; tabs stream health “requirement satisfied”
- **Agreeing seats:** codex (strongest mechanism), claude-opus (related one-shot/side-effect Low), grok High#2 **demoted** — peers note failed fetch still leaves `requirementRevision > satisfiedRevision`; the real hole is **stale success**
- **Summary:** `hasTabsRecoveryNeed()` one-shots into `tabsRecoveryRequestedRef`. A forced `session.tabs.list` that returns a still-cached old handle can satisfy the requirement without reminting a live covered terminal → composer stays input-locked until leave-chat / handle rebirth.
- **Smallest fix:** Re-arm recovery until the exhausted handle is absent *or* a *new* handle appears for the covered agent; do not mark satisfied on equal version alone for recovery-class requests.

### C4. Medium — Multi-question answer (and multi-image) shared budget can abort mid-sequence after partial PTY mutation

- **Severity:** Medium (product-judgment: intentional ceiling vs HEAD regression)
- **Files:** `use-mobile-native-chat-answer-send.ts` L111–224; `mobile-native-chat-image-send.ts` L48–79
- **Agreeing seats:** codex, claude-opus; grok related; fable treats as accepted limitation in places
- **Summary:** One 15s budget for Ctrl+U heal + N pastes + text, or full multi-selector key sequence. Slow relay / long key expansion truncates after partial mutation; stale-input heal helps retry but does not roll back.
- **Note:** Peers flag frequency claims as assumed. Still a real new failure mode vs per-write full budgets on HEAD.
- **Smallest fix:** Per-leg floors + partial-failure UX (“answer partially applied — check selector”); or raise budget only for multi-group answers; document intentional non-atomality.

### C5. Medium — Idle headless Pi provider-session projection / test shape mismatch

- **Severity:** Medium (headless/serve + Pi)
- **Files:** `src/main/runtime/orca-runtime.ts` (~buildPtyMobileAgentStatus / providerSessionOnly); `src/main/agent-hooks/server.ts` one-row-per-pane `lastStatusByPaneKey`; test that injects dual rows
- **Agreeing seats:** codex (best catch of counsel per peers); partially related opus providerSession staleness / idle cliff
- **Summary:** Production stores one status row per pane. Pi `providerSessionOnly` replaces the row with placeholder agentType that ownership readers refuse → `{}` when no PTY/retained OSC. Positive test supplies two simultaneous rows production cannot emit → green suite masks the gap.
- **Smallest fix:** Project ownership from `tab.launchAgent` / non-placeholder path when only providerSession exists; fix test to one-row shape.

### C6. Medium — Provider-session invalidation compares `sessionId` only (drops Pi transcript path)

- **Severity:** Medium (Pi resume correctness)
- **Files:** `src/main/agent-hooks/hook-provider-session-invalidation.ts`; `server.ts` identity extraction; `src/main/index.ts` wiring
- **Agreeing seats:** codex; grok related worktreeId drop; opus invalidation notify path
- **Summary:** Canonical Pi identity is session id **plus** transcript path. Invalidator ignores path → same id, new file keeps old transcript address on healthy tabs stream.
- **Smallest fix:** Include `transcriptPath` (and required worktreeId) in identity compare keys.

### C7. Low/Medium (perf) — Lazy hook-snapshot index forced on common session.tabs projections

- **Severity:** Low–Medium perf
- **Files:** `src/main/runtime/orca-runtime.ts` lazy getter vs call site that forces index when any terminal tab exists
- **Agreeing seats:** claude-fable (F2), claude-opus (#3)
- **Summary:** Comment claims pay-nothing laziness; projection path rebuilds host-wide snapshot work more often than intended.
- **Smallest fix:** Only force index when a pane actually needs hook agent status; keep lazy path for pure shell workspaces.

### C8. Low (perf) — Full identity scan / allocations on every hook status event

- **Severity:** Low
- **Files:** `src/main/agent-hooks/server.ts` L534–548; `src/main/index.ts`
- **Agreeing seats:** grok, codex, claude-opus
- **Summary:** Per-event full-cache passes for provider-session identity invalidation. Correctness-motivated but hot on chatty hooks.
- **Smallest fix:** Diff only the changed pane key; reuse prior identity map.

## High-signal unique findings

| Finding | Seat | Trust | Notes |
|--------|------|-------|-------|
| Uncoalesced `notifyMobileSessionTabsChanged` cancels pending coalesced emits on provider invalidation | claude-opus | High (mechanism traced) | Spot-check recommended before merge if invalidation is frequent |
| `providerSession` unbounded age vs `agentType` staleness — relaunch same pane addresses prior transcript | claude-opus | Medium | Peers note intentional unbounded resume docs; relaunch case still concrete |
| Headless 30m idle cliff drops whole `agentStatus` including valid providerSession | claude-opus | Medium | Related to C5 |
| Invalidator silently drops identities missing `worktreeId` | grok | Medium | Peer-confirmed as real gap for waiting-session fix |
| Dual route/view send-error state machines desync | grok | Medium | UI consistency, not wire protocol |
| Stop lacks generation guard (stale failure after later Stop) | grok (High) / fable (Low F4) | Medium demoted | Real race class; peers say High overstated; answer-send’s `generationRef` is the fix template |
| Empty `terminal.list` early-return skips `notifyListedHandles` | claude-fable | Low/Info | Unique gate trace |
| Card action clears only half banner state | codex / opus | Low | UX |

## Performance surface

**Checked:** stream rearm/revision bumps, SessionScreen re-renders, hook status event work, session.tabs projection snapshot rebuilds, RPC timeout floors, covered-stream setState on list refresh.

**Agreed risks:**

1. Forced hook-snapshot index on common projections (C7)
2. Per-hook-event identity scan (C8)
3. Full route re-render on covered-stream revision (Low — fable/grok; acceptable if rare)

**Residual gaps:** No seat measured production latency of multi-image paste under real relay RTT; truncation frequency is reasoned not profiled. No flamegraph of `getStatusSnapshot` under multi-workspace load.

## Functionality / regression surface

**Agreed breaks / near-breaks:**

1. Stop resolved-reject silence (C1) — **coordinator verified**
2. Shared-budget last-leg false unconfirmed / partial multi-write (C2–C4)
3. Tabs recovery stale-success one-shot (C3)
4. Pi / providerSession headless projection + invalidation path (C5–C6)

**Disputed / demoted:**

- Grok High “failed recovery permanently locks forever” — peers + fable falsify failed-fetch path; keep only stale-success variant
- Grok “overrun amplified across sequential writes” — floor is ≤1s once per write that still starts; post-deadline writes short-circuit at 0
- Whether multi-write truncation is a **defect** vs **documented budget product contract** — still needs product call; UX must not claim “not sent” for partial success
- Opus High on sub-second timer — peers note outcome is unconfirmed not false not-sent; still double-send risk → keep elevated

## Peer ratings (blind)

**Peer ratings were blind (anonymized labels A–D).** Coordinator map (not shown to workers during rating):

| Letter | Seat |
|--------|------|
| A | claude-fable |
| B | grok |
| C | codex |
| D | claude-opus |

### Aggregate mean scores (4 raters each)

| seat | letter | evidence | regression_catch | false_positive_risk (5=trustworthy) | actionability | overall |
|------|--------|---------:|-----------------:|------------------------------------:|--------------:|--------:|
| claude-fable | A | 5.00 | 3.50 | 5.00 | 4.50 | **4.50** |
| claude-opus | D | 5.00 | 4.50 | 3.50 | 5.00 | **4.50** |
| codex | C | 5.00 | 5.00 | 4.00 | 3.75 | **4.44** |
| grok | B | 4.00 | 3.75 | 2.75 | 4.25 | **3.69** |

**Most trusted calibrator:** **claude-fable (A)** — highest false_positive_risk trust, green-gate discipline, tight severities.  
**Best regression catch:** **codex (C)** — only seat all raters scored 5 on regression_catch.  
**Most actionable host/mobile deadline analysis:** **claude-opus (D)**.  
**Most noisy / severity-inflated:** **grok (B)** — broad inventory still useful; do not act on High labels unfiltered.

Full letter tables: `ratings-blind/{grok,codex,claude-opus,claude-fable}.md`  
Unblinded aggregates: `ratings/aggregates.md`

## Seat scorecards

### grok (letter B)
- **Strengths:** Broad hot-path coverage; stop generation-guard vs answer-send contrast; dual error-banner desync; worktreeId invalidation drop.
- **Blind spots:** Severity inflation (two Highs peers demoted); recovery mechanism half-wrong (failed vs stale success); budget accumulation overstated.
- **Trust weight this run:** Low–medium for severity; medium for inventory.

### codex (letter C)
- **Strengths:** Production-vs-test falsification on Pi; stop silent-reject; stale-success recovery; transcriptPath invalidation; multi-write truncation class.
- **Blind spots:** Less fix-shape specificity; truncation frequency assumed.
- **Trust weight this run:** **High** for regression existence proofs.

### claude-opus (letter D)
- **Strengths:** Deepest shared-budget / last-leg timer analysis; uncoalesced notify path; providerSession staleness / idle cliff; actionable fix shapes.
- **Blind spots:** Missed stop resolved-reject silence while greening stop accounting; some High inflation; provider flap premise partly unproven.
- **Trust weight this run:** **High** for mobile send budget + host notify mechanics.

### claude-fable (letter A)
- **Strengths:** Full gate suite green; adversarial falsification of rearm/budget core claims; stop silent-reject with mock-gap proof; conservative severities.
- **Blind spots:** Shallowest catch rate; some “no defect” claims peers partially disproved (recovery stale-success, budget partials as pure classification).
- **Trust weight this run:** **Highest** for “is this real?” filtering.

## Recommended next actions

Ordered smallest-first; no drive-by refactors.

1. **Stop `sawRejected` on resolved non-accepted** (`use-mobile-native-chat-stop.ts`) + unit test with `{ok:false}` / non-accepted mock. *(C1 — consensus, verified)*
2. **Min-write floor / refuse-to-start on terminating text+Enter** when shared budget remaining &lt; floor (mirror image loop). *(C2 — high peer actionability)*
3. **Tabs recovery: do not satisfy on equal/cached snapshot** for exhaustion recovery; require handle change or presence proof. *(C3)*
4. **Partial multi-write UX** for answer/image when budget aborts mid-sequence (message that does not invite blind retry into half-stepped TUI). *(C4)*
5. **Pi / providerSession projection:** one-row-safe ownership + fix dual-row test; include `transcriptPath` in invalidation identity. *(C5–C6)*
6. **Perf polish (post-correctness):** lazy snapshot index only when needed; pane-scoped identity diff on hook events. *(C7–C8)*
7. **Optional:** stop generation ref (answer-send pattern) to kill stale late verdicts; dual banner state machine consolidate.

## Artifacts

```
.llm-counsel/20260726-164449/
  COUNSEL-REPORT.md          ← this file
  reviews/
    grok.md
    codex.md
    claude-opus.md
    claude-fable.md
  reviews-blind/             A.md–D.md (anonymized)
  ratings-blind/             per-rater letter tables
  ratings/aggregates.md      unblinded means
  blind-map.json             coordinator-only letter↔seat
  base.txt / head.txt / branch.txt / diff-stat.txt
```

## Next step for human

Say whether to **implement consensus Critical/High/Medium fixes (C1–C3 first)** in this worktree, or only open tracking issues.
