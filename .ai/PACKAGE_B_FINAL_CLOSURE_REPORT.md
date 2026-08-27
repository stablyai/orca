# Package B — Final Closure Report

| | |
|---|---|
| Branch | `jb-workflow-control-plane-b` (one worktree, one branch, sole editor) |
| Base at dispatch start | `b954873e83` |
| Pinned `origin/main` | `249d93bc5d2fd3b04581aae9916afc84bc787c8b` — **ancestor of HEAD: yes** |
| Final SHA | `d7405b348bc300db536a1a6b51cc94cb6da8301f` |
| Commits added | `4d05afe5b0`, `5579d4378b`, `d7405b348b` |
| Rollback point | `4d05afe5b0` (first of the three; `b954873e83` reverts the whole dispatch) |
| Candidate runtime | `9a4c6d41-12e6-42c4-9029-9ac7834035d8`, isolated `ORCA_DEV_USER_DATA_PATH`, torn down |
| Native runtime | `868298d7-29b6-413d-b374-507abfb6e019` — not mutated, verified healthy after teardown |
| Helper | one native read-only Sonnet mapper; requested `sonnet`, effective `claude-sonnet-5`. Read-only: no edit, stage, commit, worktree, Orca call, or sidebar worker. Its findings were independently re-verified before use. |
| Not done | no push, no PR, no release, no install, no native restart, no merge, no deploy, no second Run |

## The one defect behind all of them

Every blocker was the same shape: **the runtime recorded what a caller said instead of what it could see for itself.** The fixes are not new subsystems — in each case the evidence was already reachable and simply wasn't read.

## Blockers

### 1 — Runtime-owned completion and gate proof · CLOSED
`validateCompletionReceipt` compared `claimedSha` to `headSha` and read `worktreeClean` — all three fields from the worker's own payload. A worker sending two equal SHAs and `worktreeClean: true` passed a gate that had observed nothing.

- `runtime-observed-completion.ts` runs `git rev-parse` / `git status` / `git diff` in the Dispatch's own worktree.
- `runtime-gate-execution.ts` executes the gate via `runProcessSync` and records exit code, log digest and build id; only a zero-exit row for `(scope, gate, finalSha)` counts.
- New rejections: `evidence_unobservable`, `sha_not_observed`, `changed_files_mismatch`, `gate_not_executed`. A missing or unobservable observation **fails closed**.

**Live**: on the candidate, a fabricated PASS (SHA never observed, claimed clean, claimed PASS) and a real-HEAD PASS with no runtime-executed gate were both rejected — task stayed `dispatched`, **zero phase launches, zero reviewer Task/Dispatch/session**.

### 2 — Immutable build provenance · CLOSED, plus a defect found in the fix itself
Provenance is folded in at build time via a vite `define`. A dirty build names no commit.

**A real bug surfaced during certification**: vite writes `electron.vite.config.<timestamp>.mjs` into the repo root *before* evaluating the config, so provenance measured there always read the tree as dirty. `commitSha` was therefore unconditionally `null` — the check was on and silently proving nothing. Fixed by ordering, not leniency (`d7405b348b`): the build wrapper measures first and hands the record down. The strict "any change is dirty" rule is unchanged.

**Receipt**: `{"sourceSha":"d7405b348b…","dirty":false,"appVersion":"1.4.178-rc.2"}` — the artifact names its exact commit.

### 3 — Runtime-owned gate dependencies · CLOSED
The receipt fingerprinted exactly the files the worker claimed, so under-reporting minted a receipt nothing it touched could invalidate. Now the union of Git's own diff and the claim; the claim can only widen the set, never narrow it.

### 4 — Validation lease on every mutation path · CLOSED
The lease had exactly **one** consumer (`workerStart`'s local branch). `git.*`, `files.*`, `terminal.send`, `worktree.*`, `repo.*` had no fence at all. One fence at the dispatcher, because the invariant belongs to the boundary — twenty guards is twenty chances for the twenty-first method to be added without one. Cheap: one indexed "any live lease" read before resolving any selector.

**Live, on a real running Orca**: lease acquired → `terminal.send` refused with `validation_in_progress` → lease released → **the same send succeeded**.

### 5 — Recoverable phase-start crash state · CLOSED
The existing `pending → starting → started/start_unknown/blocked/failed` machine with durable mutation receipts was already sound. One residual gap fixed: a row with no route but an existing Dispatch was routed to `blocked` before reconcile ran, reporting a live worker as never started. It now adopts the existing Dispatch; a phase that genuinely has none is still blocked.

### 6 — Exact-process terminal-output liveness · CLOSED
Activity evidence read the terminal **handle**, which outlives its process, with no start floor — so output from whatever occupies the pane now read as the dispatched worker still working, and a hung worker never reached `stalled`. Now scoped to `process_incarnation` and floored at the Dispatch's start. (A timezone bug in my own floor — SQLite's timezone-less UTC parsed as local — was caught by the test and fixed.)

### 7 — Atomic 2–5 intake, deadlock detection, federated fence · CLOSED
- A plain `serialize` cycle cannot deadlock (symmetric mutual exclusion). Two shapes genuinely do, and both are now refused at intake: an outcome serialized against itself, and two outcomes a `merge` chain already made one.
- **The federated bypass was real**: `--on <host>` checked the route and nothing else, leaving a serialized outcome and a leased worktree fenced locally and wide open federated. Both branches now assert identically.

**Live**: merge-plus-serialize refused with the deadlock reason; the coherent pair admitted.

### 8 — One route contract · CLOSED
`route-registry-discovery.ts` read only `AGENT_HOOK_TARGETS` ("does Orca install its scripts") as the answer to "can Orca observe this agent". OpenCode ships its own hook plugin, so it was reported as `launcher_supported_hook_rejected` drift while the route contract said its hook path was fine — two deliberately-written, never-reconciled truths, each pinned by its own passing test. Both now read `hasAgentHookIngestion`.

**Live**: `opencode` → `hookSupported: true`, `drift: []`. Negative control `aider` (neither mechanism) → still `launcher_supported_hook_rejected`.

### 1b — SSH / WSL execution boundary · found and fixed during certification
Blocker 1's observation ran `git` **on this machine** against the Dispatch's recorded worktree path. For an SSH or WSL worker that path belongs to another host — and an identical path can exist locally, so the observation would answer confidently for the *wrong repository*. `docs/reference/ssh-execution-boundary.md` names exactly this: *"A missing SSH provider is not permission to answer locally — a local run can answer for the wrong repository."*

The observation now refuses to answer whenever the Dispatch's host scope is `ssh` or `wsl`, naming the owning host in the reason. Proven with a test where the tree **is** readable locally — the trap case — plus a local negative control.

### 9 — Failed work never advances · CLOSED (was already sound)
Verified no bypass exists: every path into `planNextAfterBuild` runs the eligibility check first. Its strength depended entirely on blocker 1 — `gateResult` was the worker's own claimed `receipt.result`. That dependency is now closed.

### 10 — Settled-worker spinner · CLOSED
The dot was driven entirely by agent-hook events and terminal titles, neither of which knows the control plane settled the Dispatch; a finished worker kept spinning for the full 30-minute staleness window. `dispatchStatus` already reached the renderer — the summary now lets the runtime's verdict outrank the hook.

### 11 — Exact-head certification · DONE
Clean build at `d7405b348b`, isolated candidate, live proofs above, receipts persisted, candidate torn down and its user-data removed.

## Unproven claims — stated plainly

1. **Route smoke matrix (Opus, Sonnet, GLM-5.3, Gemini Flash, Grok, Fable, Sol/Codex) was not run.** Each route requires launching a real provider session, which the standing "no additional provider sessions" constraint forbids. What *is* proven live is the classification layer every route passes through (upsert, hook ingestion, drift, matrix) plus its negative control. **Fable is therefore not proven PASS.**
2. **Blocker 1's discriminating rejections were proven at exact head by test, not live.** On the candidate both fabricated completions failed closed at `evidence_unobservable`, because a plain `dispatch` has no worktree; separating `sha_not_observed` from `worktree_dirty` from `gate_not_executed` needs a worker Dispatch bound to a real worktree, which means launching an agent.
3. **Blocker 10's fix is proven by unit test, not by Playwright CDP.** The selector change is exercised with its negative controls; I did not drive the rendered UI.
4. **`git.commit` / `files.write` fencing is proven through the dispatcher by test**, not over the live socket — those are RPC-only surfaces with no CLI command. `terminal.send`, the stronger case (it had no fence whatsoever before), was proven live.
5. **The lease fence resolves a worktree only when a lease is already live.** If selector resolution throws, the call proceeds rather than failing closed — deliberate, so an unresolvable selector stays the handler's error to report rather than being masked as a fence error.
6. **Remote (SSH/WSL) completions now fail closed rather than being verified.** Declining is strictly correct — answering locally could certify the wrong repository — but it means a remote worker cannot currently pass the completion gate. The full fix is to delegate the observation to the execution host through `orca-runtime-git.ts` (which already carries the provider guard); that requires making the reconcile path async, which is beyond this dispatch's frozen blocker list. **This is the single most important follow-up.**
7. The `.ai/` receipts file reports `worktree_clean: NO` because it was captured while being written into the tree. The tree is clean at `d7405b348b` plus these two documents.
