# ORCA_NATIVE_ROUTE_TRUTH and SCL policy drift

Task `task_2523bb30104c` · Dispatch `ctx_cfb69a42239a` · Run `run_940419794b63`
Base `fecdf0bde8850b81403df4609fbc98d0e805f31f` · Correction head `4a0cae2626788c86522f925465aa1804f375eca1`

## ORCA_NATIVE_ROUTE_TRUTH

Derived from native Orca's own catalogs at this exact head, not from any launcher
allowlist. Pinned by `src/shared/native-route-contract.truth.test.ts`, so a catalog change
moves this table loudly.

| Route | Native harness | Native launch? | Exact current route | Verdict |
| --- | --- | --- | --- | --- |
| Opus | `claude` | **yes** | `--model opus` (family alias; `listModels` discovers exact per-host name) | `NATIVE_ROUTE_SUPPORTED` |
| Fable | `claude` | **yes** | `--model fable` | `NATIVE_ROUTE_SUPPORTED` |
| Sol / Codex | `codex` | **yes** | `-m gpt-5.6-sol -c model_reasoning_effort=<minimal…ultra>` | `NATIVE_ROUTE_SUPPORTED` |
| Gemini Flash | `gemini` | catalog can pin, **not opted in** | `-m gemini-3-flash-preview` | `BLOCKED_SAFE_LAUNCH_POLICY_DRIFT` |
| Grok | `grok` | catalog can pin, **not opted in** | `-m grok-4.6 --reasoning-effort <v>` | `BLOCKED_SAFE_LAUNCH_POLICY_DRIFT` |
| GLM-5.3 | `opencode` | **no** | — (no session-option catalog at all) | `TRULY_UNSUPPORTED` |
| Local Qwen | `qwen-code` | excluded by policy | — | outside Orca worker routing, by design |

Three corrections to my own earlier phase-5 report, which was wrong because it read the
launcher's behaviour instead of the catalog:

- **Opus and Fable are natively supported.** I previously reported them FAIL /
  `identity_proof_insufficient`. `claude` is opted into worker launch, pins `--model`, and
  can discover exact per-host model names. The gap was in my identity *proof*, not in Orca.
- **Gemini and Grok are policy drift, not provider incapability.** Both catalogs seed the
  model and carry `modelApply.launchArgs`. Only `supportsWorkerLaunchPreferences` is absent.
- **`gemini-3.7-flash` has never existed in Orca's catalog.** Native Flash is
  `gemini-3-flash-preview`.

## PRETOOL_DRIFT_ROOT_CAUSE

`.codex/hooks/pre_tool_use_policy.py:334-342` in `scl-platform/launcher-repair-opus` holds a
`valid_routes` set of `(agent, model)` tuples: `("gemini","gemini-flash-latest")`,
`("gemini","gemini-3.7-flash")`, `("opencode","zai-coding-plan/glm-5.3")`,
`("opencode","glm-5.3")`, `("claude","opus[1m]")`, `("claude","sonnet[1m]")`,
`("claude","fable")`.

**There is no `codex` tuple.** Every Codex route is therefore denied through the sanctioned
wrapper, and the denial falls through to the generic *"single exact command; shell chaining…
blocked"* message (lines 358-361), which describes a shell-safety violation rather than the
real cause. `codex` is simultaneously recognised as a real agent id in three other places in
the same repo — `WORKER_START_AGENTS` (`safe-orca-agent-launch.py:180`), the raw-terminal
blocklist regex (`pre_tool_use_policy.py:259`), and the argparse help text (line 2376).

This is the single most consequential drift: **Sol/Codex is the one route Package B has
certified PASS end to end, and SCL policy blocks it.** Typed: `BLOCKED_PRETOOL_POLICY_DRIFT`.

## SAFE_LAUNCH_DRIFT_ROOT_CAUSE

`.codex/scripts/safe-orca-agent-launch.py`:

- `:181` `KNOWN_AGENTS = {"gemini", "opencode", "claude", "codex"}` — rejects everything else
  with `INVALID_AGENT` / *"Unknown or unapproved Orca agent id."* An allowlist omission
  phrased as disapproval; `grok` is rejected here despite a native catalog entry.
- `:128` `GEMINI_REQUIRED_MODEL = "gemini-3.7-flash"` and `:127`
  `GEMINI_ALIAS = "gemini-flash-latest"` — pins a model id Orca has never had.
- `:131` `GLM_53_MODEL = "zai-coding-plan/glm-5.3"` — the only opencode model permitted.
- `:478-519` `canonical_model()` enumerates Claude base families literally
  (`opus`/`sonnet`/`opusplan`/`claude-opus-*`/`claude-sonnet-*`/`fable`) and forces a `[1m]`
  suffix. Any new Claude family Orca adds hits `CLAUDE_1M_REQUIRED` even when Orca supports it.

Not all of these are drift. `GEMINI_FORBIDDEN_MODELS = ("gemini-3.5-flash",)` and the GLM
agent shell-deny list are **explicit, evidence-based security/correctness reasons** (a prior
benchmark displayed 3.7 while serving 3.5), and the correction preserves them.

## OLD_BAD_PR_EFFECT

`git log -S` shows `valid_routes`, `KNOWN_AGENTS`, `WORKER_START_AGENTS`,
`GEMINI_REQUIRED_MODEL` and the literal `gemini-3.7-flash` each have **exactly one** commit in
the entire history of those files: **`5629171c` (2026-08-25), "chore(agents): harden Orca and
Flash identity workflow (#966)"**. The routing table has never been edited since.

So this is not a regression from a later change. The `codex` gap was baked in at creation:
that commit added `codex` to `WORKER_START_AGENTS`/`KNOWN_AGENTS` in the same change that
created `valid_routes` without a `("codex", …)` tuple. The three subsequent commits explicitly
scoped to launcher repair — `fc60a97a` (#967), `94e1c97f` (#970), `b588f759` — touched the
Gemini probe, TOML policy validity, durable launch phases and Run-purpose admission, and
**none of them touched the routing table**. The drift survived three repairs because no repair
was looking at the table.

Does the correction permanently remove the drift? **On the Orca side, yes**: route capability
is now derivable from one contract, and a launch refusal states which of the four typed
verdicts applies. **On the SCL side, not yet** — that repo is outside this lane and was read
only. The drift ends there only when its policy derives from `orchestration.routeTruth`
instead of re-encoding a table by hand.

## DUPLICATED_ROUTE_TABLES_REMOVED / SINGLE_ROUTE_CONTRACT

An inventory of this Orca worktree found **no currently-realised contradiction between its own
route sources** — the honest finding is that Orca's three sources are *orthogonal facts*, not
duplicates of each other:

| Fact | Source | Consumed by |
| --- | --- | --- |
| can Orca launch this agent | `TUI_AGENT_CONFIG` | `isLauncherSupported` |
| does Orca install hooks into it | `AGENT_HOOK_TARGETS` | `isHookSupported` |
| what models/effort it takes | session-option catalogs | identity proof, reasoning modes |
| excluded from worker routing | `EXCLUDED_WORKER_AGENTS` (`['qwen-code']`) | route eligibility |

The duplication is **external**: a downstream policy needing "may this route launch?" had to
re-derive all four by hand. The correction is therefore consolidation, not deletion:
`resolveNativeRouteCapability` returns all four facts in one answer, `classifyNativeRoute`
turns them into one typed verdict, and `orchestration.routeTruth` publishes it over RPC/CLI.
Nothing that was a genuine independent fact was removed; what was removed is the *need* for
anyone else to assemble them.

Two latent risks found and reported rather than silently fixed, being outside this lane:
- `TUI_AGENT_AUTO_PICK_ORDER` and `AGENT_KIND_VALUES` mirror the agent union with `satisfies`,
  which checks membership but not completeness, so a new agent can be silently omitted.
- `COMMIT_MESSAGE_AGENT_SPECS`'s static Claude seed lists `haiku`/`sonnet`/`opus` but not
  `fable`, disagreeing with the Claude catalog. Its `modelSource: 'dynamic'` masks this at
  runtime.

## Smallest exact SCL handoff (that lane's owner, read-only from here)

1. Add `("codex", <model>)` tuples to `valid_routes`, or better, replace the tuple set with a
   call to `orca orchestration routeTruth --agent <a> --model <m> --json` and admit on
   `NATIVE_ROUTE_SUPPORTED`. This alone unblocks the certified Sol/Codex route.
2. Replace `GEMINI_REQUIRED_MODEL = "gemini-3.7-flash"` with the native id
   `gemini-3-flash-preview`. Keep `GEMINI_FORBIDDEN_MODELS` and the served-model probe: that
   check is evidence-based and still correct.
3. Derive `KNOWN_AGENTS` from route truth rather than a literal set, so `grok` stops being
   `INVALID_AGENT` for a reason that is really an Orca opt-in gap.
4. Leave the GLM shell-deny list and the Claude 1M requirement alone; both carry explicit
   security reasons.

Orca-side follow-up, not done here because it changes launch policy rather than correcting
accuracy: decide whether `gemini` and `grok` should set `supportsWorkerLaunchPreferences`.
Until that decision, both correctly report `BLOCKED_SAFE_LAUNCH_POLICY_DRIFT`.

## Live receipts produced on the isolated candidate

Candidate `bd0467e5-27f4-44ff-9ca0-ac61ea8f052d` → `95ae609d-1ac9-48a3-805e-17e8e2a4a74b`
(Electron `--serve`, `/tmp/orca-cand-i/userdata`, port 6887). Isolation proven on first contact:
`runs: ['run_legacy_local']`, `worktrees: 0` — zero of the user's real Runs or worktrees.

| Receipt | Live result |
| --- | --- |
| `ORCA_NATIVE_ROUTE_TRUTH` | `orchestration route-truth` returned the same eight verdicts the source-derived table predicts. |
| `CERTIFICATION_EVENT_INTEGRITY` | On a freshly launched builder, `completion_receipt`, `failure_recovery`, `role_execution`, `duplicate_prevention`, `effective_model_identity` and `effective_reasoning_mode` were each REFUSED with a distinct typed reason, while `fresh_launch`, `safe_launch_acceptance` and `task_dispatch_worktree_binding` were admitted. After the builder actually settled, the identical `completion_receipt` / `role_execution` / `duplicate_prevention` calls were ADMITTED. The runtime decides; the caller only requests. |
| `INCREMENTAL_GATE_REUSE` | A correction that edited only `x.ts` moved the SHA: `gate-x` reran (`Inputs changed since the receipt: file:x.ts`), `gate-y` **reused across the Git SHA**, `review-gate` reran (`bound to its exact head`). Same path with different contents reran `gate-y`. |
| `VALIDATION_MUTATION_FENCE` | With a lease held, the guard reported `allowed: false` with remedies `wait_for_lease_completion, use_separate_worktree`; re-engaging the ALREADY-RUNNING builder into that worktree was refused naming the lease. Release without `--dispatch` was refused; release by the wrong owner returned `released: false`; release by the rightful owner returned `released: true`. |
| `TERMINAL_OUTPUT_LIVENESS` | Liveness read `live / working` from `Worker has an active tool call`, and the runtime's own `lastOutputAt` was populated on the worker terminal and wired into the sweep. The threshold behaviour (output without a new hook event is not stalled; silence past the window is) is proven deterministically. |
| `BATCH_2_TO_5_INTAKE` | One CLI call admitted 3 outcomes to 3 distinct Runs with a serialize decision recorded; an identical replay returned the same receipt with no duplicate rows; an undecided overlap was refused and left **0** outcomes admitted. |
| `FAILED_WORK_NO_REVIEW` | A builder reported `--outcome failed`. Result: **0** review phases, **0** outcome phases, **0** reviewer Dispatches, no new Dispatch, and one typed `Protected blocker: completion_not_accepted`. |
| `SHA_RUNTIME_BINDING` | See below — the first attempt FAILED review and was corrected. |

### SHA_RUNTIME_BINDING: what the live proof caught

The first candidate run **disproved** my own claim. `orchestration certify` accepted a caller-supplied
`bbbb…` SHA and wrote it, and the stamped runtime identity was `43.1.0+a228ab7d548e8790` — Electron's
version plus an entry-file hash, with no relationship to the Git head `4a0cae2626`. Certification was
therefore neither SHA-bound nor build-bound; the later worker-start refusal I had pointed at was caused
by other missing evidence, not by staleness.

Corrected: the runtime now resolves the commit it was built from through the repository's own sync git
runner, carries it in the build identity (`version+buildHash+commit`), and `admitCertificationEvidence`
rejects a mismatched claim at RECORD time (`sha_mismatch`) or refuses entirely when the runtime cannot
establish its own commit (`commit_unknown`). PASS evidence is stamped with the runtime's commit, never
the caller's. Negative controls cover SHA A→B, runtime A→B, an unknown commit, and the substitution
attempt.

## Control Room pre-completion findings — resolution

Ten specific claims were raised against the first version of this correction. I had two
subagents verify each against source rather than accepting or dismissing them. **All ten
verified TRUE.** Every one is now fixed, and each fix carries a negative control that was
observed failing against the pre-fix code.

| Finding | What was actually wrong | Resolution |
| --- | --- | --- |
| 1a `duplicate_prevention` | Accepted capability revocation, which EVERY clean completion does — so it minted PASS for a Dispatch nothing was replayed against | Requires an actually rejected duplicate completion |
| 1b `failure_recovery` | Accepted any failure; a failure is not a recovery | Requires the failure AND later work on the same Task |
| 1c reviewer `role_execution` | Accepted `start_unknown`, which is the opposite of proof | Requires `started` |
| 1d `pretool_acceptance` | Accepted the presence of a tool row as an accepted decision | Requires a recorded PreTool decision; fails closed today |
| 1e `safe_launch_acceptance` | Accepted a launch token as an admission | Requires a recorded admission decision; fails closed today |
| 1f effective identity | Treated "differs from requested" as provider-observed, though a catalog can transform a request with no provider involved | Only an explicit `observed` stamp counts |
| 2 SHA/runtime | Worker-start derived the "current" SHA from the evidence it was checking — the evidence authorised itself | The runtime states its own commit; a packaged build with no repository fails closed |
| 3 validation lease | Read-then-write with no transaction; owner taken on trust; nonpositive TTL accepted; expired leases returned as live credentials | `BEGIN IMMEDIATE`, owner verified against real Dispatches on the Run, TTL rejected, expiry-aware lookup |
| 4 incremental gates | A gate declaring no real inputs had a permanently reusable receipt | Config-only inputs fail closed |
| 5 batch intake | `batchId` identified nothing (replay could enlarge a batch), relation decisions were silently overwritable, duplicate/nonexistent Run ids were unchecked, and **`serialize` was stored and never read by anything** | Immutable manifest fingerprint per batch, decision changes refused, Run ids deduped and existence-checked, and `serialize` now gates worker launch |
| 6 GLM-5.3 | **My own error.** I classified it `TRULY_UNSUPPORTED` because `opencode` is absent from `AGENT_HOOK_TARGETS` | That list means "Orca installs managed hook scripts". OpenCode ships its own plugin, is resumable via `opencode --session`, and has a full launch config. Now `IDENTITY_PROOF_INCOMPLETE`; `TRULY_UNSUPPORTED` is reserved for no launcher or explicit policy exclusion |

Finding 6 deserves naming plainly: it is the same class of mistake this addendum exists to
correct — reading one system's internal list as though it answered a different question — and I
made it while correcting it in someone else's code.

Finding 5's serialization gap was the most consequential: an operator could decide two outcomes
must not run together, Orca would record that decision, and then launch both anyway.


## Route appendix: two native launch strategies, and what SINGLE_ROUTE_CONTRACT really is

A later read-only matrix showed my contract was still under-reporting, in a way that repeats the
original mistake at smaller scale: I modelled only ONE way Orca launches an agent.

Native Orca has **two** launch strategies, and both are native:

| Strategy | What it is | Who has it |
| --- | --- | --- |
| `worker_start_preferences` | Orca composes the command line from its session-option catalog (`--model`, effort) | claude, codex, cursor |
| `custom_terminal_attach` | The caller supplies the command; Orca creates the terminal, supervises it and hooks it | every agent with a launch configuration |

So `gemini -m gemini-3-flash-preview`, `grok -m grok-4.6 --reasoning-effort xhigh` and
`opencode --model zai-coding-plan/glm-5.3 --agent scl-glm-builder --auto` are all **native launch
PASS**. What differs is only whether Orca can compose and verify the command itself. The contract now
carries `launchStrategies` and `nativeLaunchPossible`, so a verdict short of
`NATIVE_ROUTE_SUPPORTED` can never be read as "Orca cannot launch this".

Corrected reading of the verdicts:

| Route | Native launch | Verdict, and what it is actually about |
| --- | --- | --- |
| Opus, Fable | PASS (both strategies) | `NATIVE_ROUTE_SUPPORTED`; exact effective identity still needs a provider-observed receipt |
| Sol / Codex | PASS (both strategies) | `NATIVE_ROUTE_SUPPORTED`; blocked downstream by `BLOCKED_PRETOOL_POLICY_DRIFT` in SCL |
| Gemini Flash | PASS (custom terminal) | `BLOCKED_SAFE_LAUNCH_POLICY_DRIFT` — the STRUCTURED path is not opted in |
| Grok | PASS (custom terminal) | `BLOCKED_SAFE_LAUNCH_POLICY_DRIFT` — same |
| GLM-5.3 | PASS (custom terminal) | `IDENTITY_PROOF_INCOMPLETE` — Orca launches and hooks it, but has no catalog to compose or verify the model |

### SINGLE_ROUTE_CONTRACT status: PASS inside Orca, FAIL end to end

Inside this repo the derived contract is now the single source every internal consumer reads:
worker-start admission, the safe-launch preference path, retained re-engagement (which routes through
the same admission), and the `orchestration.routeTruth` RPC/CLI that publishes it.

It is **still FAIL end to end**, and honestly so: SCL's PreTool policy and safe launcher keep their
own hard-coded tables and consume nothing. That is outside this lane and read-only from here. The
contract now exists and is queryable; it becomes the single contract when those two consumers read
`orca orchestration route-truth` instead of their own tuples. That is the whole of the remaining
work for this item, and it belongs to the SCL lane.
