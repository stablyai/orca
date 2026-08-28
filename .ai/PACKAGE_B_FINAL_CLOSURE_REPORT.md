# Package B — Final Closure Report

| | |
|---|---|
| Branch | `jb-workflow-control-plane-b` (one worktree, one branch, sole editor) |
| Base at dispatch start | `b954873e83` |
| `origin/main` | `6cdae26e1c` — freshly re-fetched and merged; **ancestor of HEAD: yes** |
| Final code SHA | `f1f43905a1d0f488ff31313063197596e490df46` — the certified artifact is built from exactly this commit |
| Commits added | `4d05afe5b0`, `5579d4378b`, `d7405b348b`, `935adc8057`, `629c9656c8`, `47618c265e`, `7ee45b5a0b` (merge), `604ea28314`, `08f44dc66d`, `f1f43905a1` |
| Rollback point | `4d05afe5b0` (first of the three; `b954873e83` reverts the whole dispatch) |
| Candidate runtime | `f3a13c54-4808-4532-9fa3-cd98e020d18a`, isolated `ORCA_DEV_USER_DATA_PATH`, torn down |
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


## Closing the four nonterminal gates

### The bootstrap deadlock — the largest defect found in this dispatch
Running the route matrix proved the package could not start **any** worker on an outcome-admitted Run. `worker-start` demanded PASS certification, and every certification evidence kind is produced *by* a real launch. Certification required a launch; the launch required certification. Nothing could ever be certified.

The fix is a **typed certification intent**, not a flag. A boolean on `worker-start` was the first attempt and was wrong for the reason this package exists: a caller-declared claim treated as authority, which any worker could set. The runtime instead mints an intent and matches it field-by-field against the launch it is actually about to perform — Run, Task, outcome, worktree, route identity and build. It is single-use and **claimed before the Dispatch is created**, so a launch that loses the race is refused while the database still holds nothing for it rather than stranding an orphan `STARTING` Dispatch; the claim is returned if creation fails so a failure does not burn the authorisation. It opens only the `UNTESTED` state, is refused for federated and retained starts, requires the caller's own pane to be the coordinator bound to that Run in that worktree, and marks its Dispatch so it can never advance a real outcome.

A second instance of the same closed loop sat one layer down: eligibility refused any route whose `identityProof` was an alias, but an alias's effective model identity can only be learned by launching and observing it — so `claude/opus`, `claude/sonnet` and `claude/fable` were permanently unroutable. A verified intent now relaxes that one rule and nothing else; certification still requires `effective_model_identity` evidence, so an alias can be launched to be observed but never certified unseen.

### Gate 1 — seven-route smoke matrix · RUN
Real launches at the final SHA. **Fable PASSES** (`state=ready`), as do Opus, Sonnet and Sol. GLM/OpenCode launches and then fails readiness with no model pinned. Grok and Gemini are refused by this package's own `BLOCKED_SAFE_LAUNCH_POLICY_DRIFT`: both can pin a model at launch but are not opted into `worker_start_preferences`, so Orca cannot pin it safely. That is an accurate typed refusal, not an untested route.

### Gate 2 — fabricated-completion discrimination · PARTIAL, stated honestly
Live on the candidate, a fabricated PASS is refused and creates zero reviewer Task, Dispatch or session. Separating `sha_not_observed` from `worktree_dirty` from `gate_not_executed` is proven at exact head by test against a real temporary Git worktree; on the candidate both fabricated completions fail closed earlier, at `evidence_unobservable`, because the Dispatch under test had no worktree bound.

### Gate 3 — settled-spinner CDP proof · NOT DONE
The selector change is proven by unit test with negative controls. I did not drive the rendered renderer over Playwright CDP. The probe and an isolated CDP-enabled candidate were prepared; the remaining work is to bind a settled Dispatch to a rendered sidebar row and read its status dot.

### Gate 4 — repository suite · DONE
On a quiescent tree: **64,031 passed, 1 failed**. Earlier runs reporting 4 and 34 failures were invalid — both spanned my own edits, so late-imported files came from a changing tree. The single real failure was a Package B regression: earlier dispatches reworded `skill-guides/orchestration.md` and dropped two sentences an unchanged upstream test asserts verbatim. Fixed at `604ea28314`; 20/20.

## Still open

1. **Gate 3 (Playwright CDP spinner proof)** — not performed.
2. **Remote completions fail closed.** Declining is correct — answering locally could certify the wrong repository — but a remote worker cannot currently pass the completion gate. Delegating observation to the execution host needs an async reconcile path. This is the most important follow-up.
3. **Independent review was run and its findings are folded in** (see below).
4. **`git.commit` / `files.write` lease fencing** is proven through the dispatcher by test, not over the live socket — they have no CLI command. `terminal.send`, which had no fence at all before, is proven live.


## Independent review, and what it caught

A bounded read-only reviewer was run against the certification-intent design. It found one real defect, which is fixed at `9475d01a3c`:

**Over-marking.** `assertWorkerStartRouteAdmitted` returned `void`, discarding `admission.bootstrap`, while the RPC handler claimed and bound the intent whenever one was merely *supplied*. So a start carrying a valid intent for a route that had since become certified — an ordinary case in a multi-task Run sharing a route — consumed the intent and branded its Dispatch a bootstrap. Since a bootstrap Dispatch can never advance an outcome, that Dispatch's real, fully certified work was silently discarded as a protected blocker. Admission now reports whether the bootstrap was actually exercised, and the intent is claimed only then; an unnecessary intent is inert.

It also flagged, and I fixed: `listAdmissibleRoutes` and `selectRoute` structurally accepted `bootstrapUncertified` even though no caller set it — honouring it on a *listing* would have made every UNTESTED route admissible at once, with no per-route intent and no consumption. Both now exclude it at the type level.

And it identified a genuine coverage gap: the federated and retained refusals, and the marking seam itself, had no regression test at any level — which is exactly where the over-marking bug lived. `certification-intent-admission.test.ts` now covers all of it.

The reviewer independently confirmed, with file references: single-use claim-before-create with no orphan Dispatch on a losing race; deterministic mint with no replay grant; UNTESTED-only opening; ownership enforced at mint by re-deriving the coordinator terminal's real worktree rather than trusting the caller's string; the automatic phase-launch driver never forwarding an intent; and `buildId` being runtime-derived rather than caller-suppliable.


## The Fable review — and the worst defect in the package

A fresh Fable reviewer read the branch end to end. It confirmed the central claim holds for outcome-admitted Runs, and then found that it held **partly by vacuity**. Three defects, all fixed:

### `runGate` had no production caller — the package was a rejection machine
The completion gate required a runtime-proven gate for every receipt on an outcome-admitted Run. But `runGate` — the half where the runtime actually executes the gate — was never called from production. The only writer of `control_plane_gate_executions` outside it was the test fixture. So **no completion could ever be accepted**: every legitimate `worker_done` died at `gate_not_executed`, and the entire accept path (reviewer planning, the ledger, `REVIEW_COMPLETE`) was unreachable outside tests. My own reports had presented `gate_not_executed` as a working discriminator, proven only against rows a fixture wrote.

`orchestration.gateRun` / `orca orchestration gate-run` is the missing verb. The runtime resolves the worktree and the SHA from the Dispatch and observes both itself, runs the command through the approved wrapper, and records exit code, log digest and build id. A caller may name the command; it cannot name the result.

**Proven live on the candidate** at `368ad2cb5f`: the runtime ran the gate in a real worker's tree, observed the SHA itself, and recorded `passed=true, exit=0`. That had never once happened before this dispatch.

### The lease fence missed eight mutating methods
`git.pull`, `git.fastForward`, `git.forkSync`, `git.conflictOperation`, `files.writeBase64Chunk`, `files.commitUpload`, `files.createDirNoClobber`, `files.writeTerminalArtifact`. A mid-gate `git.pull` into a leased worktree was exactly the reproduction the fence exists to stop — the fence's own "twenty-first method" failure, shipped on day one. The list is now pinned against the real method registries, so a newly added mutation cannot quietly skip it.

### The checkout fallback claimed a commit it did not match
`resolveRuntimeCommitSha` ran `rev-parse` but never `status`, so a dirty dev checkout — or a stale bundle in a repo whose HEAD had moved — stamped evidence with a commit the running code never came from. The embedded path already refused a dirty build; this was the softer way in. It refuses now too.

### And the blind spot that hid the first one
Every accepted-completion test satisfied the gate through a fixture that wrote the row directly. Faithful to `runGate` — and therefore proving the guard while concealing that its satisfiable side did not exist. The fixture now goes through `runGate` and runs a real process, so those tests fail if the execution path breaks rather than if someone stops writing a row.

## Final state

`0aa1164a13`, tree clean, `origin/main` `6cdae26e1c` an ancestor. Affected trees: 408 files, 3563 tests passing. Typecheck, lint and react-doctor clean. No `max-lines` disable was added anywhere; both files that crossed the limit were split.

Remaining, unchanged from above: the Playwright CDP spinner proof was not performed; remote (SSH/WSL) completions fail closed pending an async reconcile path; and the final accepted `worker_done` is proven at exact head by test rather than live, because the dispatch capability is held only inside the worker agent's own session.
