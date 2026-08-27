# Package B addendum: native route truth and SCL policy drift

This addendum belongs to the active consolidated correction Task `task_2523bb30104c` / Dispatch `ctx_cfb69a42239a` on Run `run_940419794b63`. It does not replace any of the seven core fixes and does not authorize a new Run, worker, provider adapter, or architecture lane.

## Authority and discovery

Before changing provider routing, read the current version-matched Orca skills and current native Orca source/contracts for agent/model launch. Native Orca is authoritative for supported harnesses, launch verbs, selectors/aliases, fresh and retained behavior, reasoning/effort controls, hook targets, and requested/effective identity evidence. The old SCL PreTool allowlist, stale wrapper comments, and earlier PR assumptions are not provider truth.

Produce an evidence table for Opus, GLM-5.3, Gemini Flash, Grok, Fable, and Sol/Codex with: native harness, whether native Orca can launch it, exact current route, current SCL PreTool result, current safe-launch result, and whether drift exists.

## Correction

Trace the exact prior SCL changes that caused disagreement among native Orca support, PreTool policy, `safe-orca-agent-launch`, the Package B registry, and hook-target admission. Identify every duplicated/hard-coded route table and the exact bad assumptions. Treat a native-supported route rejected by SCL policy as typed policy drift, not provider incompatibility.

Make native Orca discovery/capability plus Package B certification evidence the authoritative route contract. PreTool, safe-launch, worker-start admission, reviewer routing, and retained re-engagement must consume that shared or deterministically derived contract. No manually maintained provider allowlists may disagree unless an explicit typed security reason applies.

Do not disable or weaken PreTool. Preserve exact worktree and Run/Task/Dispatch binding, requested/effective identity proof, duplicate prevention, protected action and production-write boundaries, and retained-session identity safety. Correct policy accuracy and derivation only.

For GLM-5.3, Opus, Gemini Flash, and Grok, first prove current native Orca behavior. Reuse an existing supported harness. Return `ADAPTER_REQUIRED` only if current native Orca genuinely lacks the route; do not build a new adapter based on SCL wrapper rejection.

Use typed classifications: `NATIVE_ROUTE_SUPPORTED`, `BLOCKED_PRETOOL_POLICY_DRIFT`, `BLOCKED_SAFE_LAUNCH_POLICY_DRIFT`, `IDENTITY_PROOF_INCOMPLETE`, `PROVIDER_AUTH_OR_QUOTA`, `PROVIDER_STARTUP_STALL`, `HARNESS_DEFECT`, or `TRULY_UNSUPPORTED`.

After policy reconciliation, run bounded harmless live certification for Opus, GLM-5.3, Gemini Flash, Grok, Fable, and Sol/Codex using the model/version exposed by current native Orca. For each report native launch, PreTool, safe-launch, requested identity, effective identity, role, fresh, retained, and final PASS/FAIL with typed reason. Never fabricate effective identity when the harness cannot expose it.

Local Qwen remains outside Orca worker routing: deterministic local evidence through Ollama qwen3.5 to a bounded local investigation.

## Required completion-report additions

Include `ORCA_NATIVE_ROUTE_TRUTH`, `PRETOOL_DRIFT_ROOT_CAUSE`, `SAFE_LAUNCH_DRIFT_ROOT_CAUSE`, `DUPLICATED_ROUTE_TABLES_REMOVED`, `SINGLE_ROUTE_CONTRACT`, route results for Opus/GLM-5.3/Gemini Flash/Grok/Fable/Sol-Codex, and `OLD_BAD_PR_EFFECT` describing exactly what broke and whether the correction permanently removes the drift.

Continue through all seven core corrections and their required tests/live proof. This addendum must not distract from or defer them.
