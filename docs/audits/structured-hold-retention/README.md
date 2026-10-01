# Structured session hold lost during resume

Run from the repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/structured-hold-retention/reproduce.mjs
```

The script bundles the actual `StructuredAgentSessionHolds` implementation into temporary CommonJS
modules, loads them normally, and removes their files and module-cache entries. It runs the code
once without the post-resume holder check and once with the current source. It uses a deferred
provider acquisition, an isolated fake child, and a 5 ms release grace. It launches no application,
provider, or terminal and reads no user profile.

The last surface releases its hold while acquisition is pending. At that point the session has no
provider child, so `release()` cannot arm the release clock. Before the fix, acquisition completes
with a child, zero holders, and no scheduled eviction. With the fix, successful acquisition checks
for surviving holders and schedules the existing release clock. The recorded child is released once.

The RPC path registers connection cleanup before awaiting `host.hold()` in
`src/main/runtime/rpc/methods/structured-agent-session-hold.ts`. Runtime socket close calls
`cleanupSubscriptionsForConnection()` in `runtime-rpc/runtime-rpc-lifecycle.ts`. That supplies the
production release-during-acquisition ordering reproduced here.

## Ownership limits

- This proves a lifecycle race, not that it caused any particular OOM report. No process RSS was
  measured. It applies to structured sessions acquiring a provider child, not ordinary PTY tabs.
- The release clock preserves its 15-second production grace, waits while a turn is active, and
  cancels when a new holder arrives. Acquisition failures retain their existing handling.
- Disposal prevents late acquisition or release callbacks from restarting the clock. Host teardown
  owns cleanup after disposal. The host's broader pre-attach shutdown admission is outside this fix.
- A restored childless journal is not necessarily abandoned. Startup selects persisted visible
  tabs; `host.sessions` supplies `listSessionTabs()`, and childless sessions can retain live TUI
  owners. `host.close()` closes that TUI owner before removing the journal. This fix neither evicts
  childless history nor infers process exit from transport loss.
- Execution remains on the owning runtime, with no wire or SSH routing changes.

Targeted regressions live in
`src/main/native-chat/agent-session-wire/structured-agent-session-hold-resume-race.test.ts`.
They cover last-holder loss, active turns, new holders, reconnection, failed acquisition, explicit
close, and disposal.

Same-ID replacement is fenced at both ownership layers. Holder entries receive a new incarnation
after release and re-add, so an old failed acquisition cannot remove a replacement. The RPC uses
the subscription registry's `releaseIfCurrent()` cleanup, so its failure cannot unregister the
replacement's connection cleanup. Duplicate adds remain one holder. Class tests and real host/RPC
tests cover the old failure arriving before and after replacement success; disconnect still releases
the replacement normally. They also cover the reverse outcome: an old acquisition succeeds and the
replacement refuses a stale fence. Its last-holder rollback starts the same turn-aware release clock
for the acquired child. No RPC fields or published frame shapes change.
