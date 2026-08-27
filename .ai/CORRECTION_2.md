# Package B correction 2 — close runtime-owned loops

Continue the same Package B outcome, worktree, branch, model, and retained session.

The first commit is a valuable substrate but is not yet a complete Package B candidate because the
builder report explicitly identifies core approved objectives with no production runtime owner.
Do not relabel these as later certification work. Wire and prove them now, staying in Orca source.

Required correction:

1. Runtime-owned liveness: connect the typed liveness classifier to the authoritative runtime
   process/session/activity/tool-call/wait/provider-exit signals. Define the sweep trigger, clock,
   persistence, idempotent transition, re-arm, shutdown, and terminal resolver. No model heartbeat.
2. Runtime-owned waiting: provide one durable subscription/sleep operation whose runtime lifetime
   is not capped by a 25/30/60-second model continuation cycle, and which wakes the coordinator only
   for WORKER_DONE, QUESTION, ESCALATION, STALLED, CRASHED, REVIEW_COMPLETE, or CI_BLOCKER. Preserve
   compatibility for `check --wait`, but it is not sufficient proof by itself.
3. Automatic builder-to-reviewer lifecycle: after validated builder completion, automatically plan
   and create the independent reviewer phase from the certified role registry. FIX_FIRST must route
   one consolidated correction to the same retained builder, then rerun invalidated gates and exact-
   SHA review. Do not choose a model/provider in control-plane logic.
4. Incremental gate receipts: wire gate planning/recording/reuse to the actual validation/preflight
   lifecycle. Reuse only when SHA, deterministic inputs/file hashes, policy and command identity prove
   validity; high-risk gates rerun.
5. Process-safe validation: wire validation leases/mutation fences to the actual test/preflight and
   worktree mutation paths so a builder cannot alter the worktree under an active suite. Preserve a
   separate-worktree/wait remedy.
6. Performance ledger: write evidence-backed entries from real lifecycle outcomes; no prose ranking
   and no fabricated usage/quota.
7. Live certification operations: expose bounded typed operations needed to register evidence and
   produce the requested fresh/retained/identity/reasoning/PreTool/safe-launch/binding/dedup/recovery/
   role matrix. Synthetic tests must never create PASS evidence.
8. Production ownership: if required wiring is in `orca-runtime.ts` or adjacent runtime files, those
   files are in scope for this correction. Keep the change narrow and split modules when necessary.

Re-run the full affected gates on the new exact HEAD, perform a fresh builder-side adversarial review,
and send exactly one `worker_done` for this correction. Report any objective that still lacks a real
call site as incomplete, not ready.
