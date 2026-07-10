# Prod Release Scan — output.md

**Verdict:** ready with accepted P1 risk  
**Span:** `v1.4.130` (`31378023`) .. `v1.4.131-rc.2` (`6964bfb23`)  
**Planned release / RC:** `1.4.131-rc.2` (user asked for 1.4.132-rc2; that tag does not exist — scanned confirmed substitute)  
**Included PRs:** 8 matched (+ `#7567` referenced only in `#7658` title, not a separate PR); unmatched commits: 5  
**Batches reviewed:** 6 (agent/mobile, codex/speech/WSL, UI defaults, xplat/remoting, perf, security)  
**Security model:** `codex --model gpt-5.6-sol -c model_reasoning_effort="xhigh"` (W6 + all workers)  
**Orchestration:** 6 same-worktree tasks injected; `task-list`/`dispatch-show` verified

---

## Issue table by PR / commit

### Has issues

| Ref | Title | Severity | Issue summary |
|-----|-------|----------|---------------|
| **#7906** | Wake slept agents when opening a worktree on mobile | **P1** (×3) | (1) Non-passive / manual-sleep wake on an **unmounted** worktree creates a tab with `activate:false` but never background-mounts → **no PTY / resume lost**. (2) Mounted manual-sleep can **double-resume** the same provider session (in-place wake + generic resume). (3) Edge-triggered wake can be **lost** if mobile opens during hibernation kill before `hibernatedWakePtyId` is armed. |
| **#7906** | (perf composition) | **P1** | Passive completed wake background-mounts the **entire** worktree → O(all saved tabs) PTY/xterm work, defeating unvisited-worktree mass-spawn guard. |
| **#7906** | (headless remoting) | **P1** | Wake is a no-op without a live renderer window; headless `orca serve --mobile-pairing` activates without waking slept agents. |
| **#7960** | Write in-Codex setting changes back to `~/.codex` | **P1** (×2–3) | (1) Missing `~/.codex/` parent → `ENOENT` on promote, then mirror **wipes** runtime setting (test pre-creates dir and misses this). (2) `writeFileAtomically` without `mode` widens **0600 → 0644** on promote (reproduced). (3) Host-only promotion path: **WSL Codex never promotes** (WSL prep skips `syncSystemConfigIntoManagedCodexHome`). |
| **#7658** | Recover WSL Codex usage RPC refresh | **P2** | Every WSL quota poll uses interactive login shell (`-ilc` + discovery chain); heavy rc cost on 15m poll / double on PTY fallback. |
| **#7977** | Disable experimental new worktree card style by default | **P2** | Fresh default is correctly off, but cohort **auto-enabled in v1.4.130** stays on via persisted `true` (no rollback migration). |
| **#7845** | Sidebar scrollbar only when overflow | **P2** (docs only) | Behavior OK; `docs/STYLEGUIDE.md` still says gutter is reserved — stale contract. |

### No issues found (clean for this scan)

| Ref | Title | Notes |
|-----|-------|-------|
| **#7860** | Separate pane identity from liveness (OMP tab flicker) | Identity vs liveness separation consistent across tab icon, PTY owner, web mirror; focused-pane owner re-owns Pi-compatible titles; no proven regression. |
| **#7932** | Chunk offline audio decoding (ONNX SIGTRAP) | 30s chunk bound + quiet split; worker-side decode; pure chunker tests pass; no malware/native dep delta. Residual: no packaged ONNX runtime on all platforms. |
| **#7933** | iOS native keyboard dictation in mobile terminal | Raw field echo; normalize only on send/mirror; no double-send proven. Mobile vitest not run (missing Expo deps in this worktree). |
| `775fa956c` | Remove mobile driver overlay preview | Delete-only HTML mock. |
| `8adfef4ff` | Update README downloads badge | `4.0m` → `4.1m` only. |
| `ff661a7ab` / `41edc493b` / `6964bfb23` | release: v1.4.131-rc.{0,1,2} | Version bumps in `package.json` only. |

---

## Findings first

### P0 — Release Blocking

None.

No malware, backdoor, supply-chain implant, lockfile/dependency implant, install-hook change, or updater/signing bypass in this span.

### P1 — Releasable Only With Explicit Acceptance

1. **#7906 Mobile wake — unmounted non-passive sleep never gets a PTY**  
   `wake-sleeping-agents-in-background.ts:43-56` only background-mounts for passive completed records; non-passive path creates inactive tab and clears the sleep record without a mounted `TerminalPane`.  
   *Evidence:* `wake-sleeping-agents-in-background.ts`, `resume-sleeping-agent-session.ts:93-118`, `Terminal.tsx:729-778`.

2. **#7906 Mobile wake — double resume of same provider session**  
   Broadcast in-place wake then generic resume for non-passive mounted records before spawn clears the record.  
   *Evidence:* `wake-sleeping-agents-in-background.ts:37-56`, `pty-connection.ts:6247-6255`, `resume-sleeping-agent-session.ts:279-315`.

3. **#7906 Mobile wake — race during hibernation kill**  
   Wake before `hibernatedWakePtyId` is armed is edge-triggered and not retried; passive path keeps record without launching.  
   *Evidence:* `pty-connection.ts:2090-2169`, `orca-runtime.ts` fire-and-forget notifier.

4. **#7906 Perf — whole-worktree background mount**  
   One passive sleep record mounts every terminal tab in the worktree permanently.  
   *Evidence:* `wake-sleeping-agents-in-background.ts:46-54`, `background-terminal-worktree-visibility.ts`, `Terminal.tsx` mount model.

5. **#7906 Headless mobile pairing — wake no-op**  
   No renderer ⇒ no wake; headless serve still returns activated.  
   *Evidence:* `orca-runtime.ts:12627-12633`, `orca-runtime.test.ts` “deliberate non-goal”, `mobile/scripts/start-emulator-pairing-runtime.mjs`.

6. **#7960 Missing `~/.codex` directory loses first promoted setting**  
   Promote does not `mkdir` system home; `ENOENT` swallowed; mirror then clears runtime value. Test pre-creates `.codex` and misses the case.  
   *Evidence:* `config-settings-promotion.ts:191-192`, `fs-utils.ts:6-14`, `config-settings-promotion.test.ts:190-191`. Reproduced: missing parent → `ENOENT`.

7. **#7960 Permission widening on promote (privacy)**  
   Atomic write without mode: `0600` → `0644` under umask `0022` (reproduced). Full user config becomes world-readable to co-tenants when parent dirs are traversable.  
   *Evidence:* `config-settings-promotion.ts:191-192`, `fs-utils.ts:11-14`.

8. **#7960 WSL never gets promotion**  
   WSL launch/rate-limit prep returns after `syncWslRuntimeForCurrentSelection` and never calls host mirror/promotion. Feature is host-only.  
   *Evidence:* `runtime-home-service.ts:139-150,225-235`.

### P2 — Nice To Have

- **#7658** Interactive login shell on every WSL rate-limit poll (`buildWslLoginShellCommand` / `-ilc`).  
- **#7960** Unchanged baseline still rewritten twice per quota cycle; CRLF insert can mix EOL on new keys.  
- **#7977** Auto-enabled experimental card cohort not rolled back.  
- **#7845** STYLEGUIDE scrollbar gutter text out of date.

---

## Clean matrix

| Area | Status |
|------|--------|
| Security / malware / supply-chain | **Clean of malice.** Lockfile unchanged; package scripts unchanged; version-only package.json. **P1 residual:** mode widen on `~/.codex/config.toml` promote. |
| Performance / resource use | **P1** mobile whole-worktree mount; **P2** baseline double-write + WSL interactive poll cost. STT chunking is an improvement. |
| macOS / Linux / Windows / WSL / PowerShell | **P1** WSL promotion gap; **P2** WSL interactive poll; CRLF insert. No new hard-coded Mac shortcuts. Real Win/WSL runtime not executed. |
| Mobile / paired web / Electron | **P1** mobile wake correctness/composition gaps; #7860 / #7933 clean by source audit. |
| Local / SSH / remote / VM / container | Wake path failures apply to local and SSH worktrees once host renderer is involved. Headless serve gap explicit. |
| Git providers / shared contracts | Not materially touched. |
| Release / package / update path | Version bumps only; no workflow/signing/native rebuild changes. |

---

## Verification

| Check | Result |
|-------|--------|
| `git diff --check v1.4.130..v1.4.131-rc.2` | Passed |
| Required security grep on non-lockfile span | 2 hits — both TOML `.exec` parsers in #7960; inspected, benign |
| `package.json` / lockfile | Version field only; `pnpm-lock.yaml` no diff |
| Mode repro (`writeFileSync` without mode) | `before 600` → `after 644` |
| Missing parent repro | `ENOENT` |
| Worker unit tests (various focused suites) | Reported green by workers (promotion, STT chunker, rate-limit, wake helpers, pane owner, etc.) |
| Mobile Expo vitest / device / real WSL / ONNX packaged | **Not run** in this environment |

---

## Orchestration provenance

| Worker | Task | Terminal | Report |
|--------|------|----------|--------|
| W1 agent/mobile | `task_20d8fd2460cc` | `term_40e66a33-…` | `reports/w1-agent-mobile.md` |
| W2 codex/speech/WSL | `task_6e280ce1760e` | `term_59f3ead8-…` | `reports/w2-codex-speech-wsl.md` |
| W3 UI/defaults | `task_7140cb2014c9` | `term_4e274a95-…` | `reports/w3-ui-defaults.md` |
| W4 xplat/remoting | `task_424816ffe823` | `term_03c7aac8-…` | `reports/w4-xplat-remoting.md` |
| W5 perf | `task_1c5ac42d7659` | `term_24778551-…` | `reports/w5-perf.md` |
| W6 security | `task_bf5de6f4913a` | `term_ae19a68d-…` | `reports/w6-security.md` |

All workers: `codex --model gpt-5.6-sol -c model_reasoning_effort="xhigh"`, same worktree, `--inject` dispatch.

---

## Residual risk

- No runtime on physical iOS/Android, Windows+WSL2, or packaged sherpa/ONNX for all platforms.  
- Lockfile/binary deltas fully inspected: **none**. Install hooks unchanged.  
- #7906 integration of IPC wake × mounted/unmounted panes × async PTY exit is under-tested relative to risk.  
- #7960 Windows ACL inheritance and concurrent external `~/.codex` edits not runtime-tested; POSIX mode widen is proven.

---

## Bottom line

**No P0.** Multiple **P1**s cluster on **#7906 (mobile wake)** and **#7960 (Codex settings promotion)**. Ship only if product explicitly accepts those gaps, or fix before stable:

1. Always background-mount (or otherwise attach) when creating a navigation-suppressed resume tab.  
2. Deduplicate in-place hibernation wake vs generic resume for the same claim key.  
3. `mkdir` system `~/.codex` before promote; pass `mode: 0o600` (or preserve existing mode) into `writeFileAtomically`.  
4. Decide WSL + headless pairing product stance (implement promotion/wake or document as unsupported).

Clean shippable areas for this span: **#7860**, **#7932**, **#7933**, release version commits, README badge, preview delete; **#7845** functionally clean with docs P2.
