# Package B correction 3 — execute automatic lifecycle routing

Continue the same Package B outcome, worktree, branch, model, and retained session.

Correction 2 now creates the reviewer and FIX_FIRST Tasks, but its report explicitly says a human or
coordinator must still call `worker-start`. That does not satisfy the approved automatic
builder-to-reviewer-to-correction lifecycle.

Close this final implementation loop:

1. After a validated builder completion, the runtime must create **and start** the independent fresh
   reviewer using the exact role-appropriate route selected from the certified registry and the exact
   worktree/outcome/Run/head binding. Do not encode a provider/model preference.
2. A FIX_FIRST verdict must create **and dispatch/re-engage** one consolidated correction to the same
   retained builder terminal/route, with no new builder session and no duplicate Dispatch.
3. After corrected completion, rerun only invalidated gates, require exact-final-SHA validation, then
   automatically start the independent reviewer again on that exact SHA.
4. Define every loop edge: trigger, immediate persisted state, authoritative event/clock, next state,
   idempotency key, retry/recovery, re-arm, and terminal resolver. A lost worker-start response must
   reconcile the same Task/Dispatch/session or fail closed; never create a replacement.
5. If the selected role has no currently certified/available route, emit the existing protected
   blocker. Do not silently fall back to UNTESTED, stale, quota-blocked, or role-inappropriate routes.
6. Preserve process-safe validation, no-model-heartbeat liveness, historical rows, and the separate
   Qwen exclusion.

Use the existing worker-start/retained-dispatch machinery rather than a parallel launcher. Add
bug-rejecting tests proving that merely creating a Task is insufficient, that the reviewer actually
starts once, that replay creates zero duplicates, and that FIX_FIRST reaches the original retained
builder exactly once.

Re-run affected/full gates on the new exact HEAD, perform builder-side adversarial review, and send
exactly one `worker_done`. Report any remaining manual lifecycle step as incomplete, not ready.
