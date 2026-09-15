# Canonical agent-status boundary

## PR 2A production ownership

The hook server owns one canonical store keyed by the full agent-status subject.
Structured-session admission gets that subject from the owning session's trusted
execution location, not from a pane key or a renderer payload. The feed retains
the exact subject for teardown even when the record and live session have already
been deleted. Desktop/runtime service and `orcad` install the same sink.

Canonical structured rows are never copied into the legacy adapter or persisted
in `last-status.json`. Their journal and session record remain durable authority.
Legacy snapshots and notifications project the committed canonical row. Combined
listing with the adapter preserves first-insertion ordering; routing indexes hold
only subjects and ordering metadata, never another status row.

PTY hooks, OSC, hydrated rows and SSH relay evidence do not yet carry trusted full
execution scope. They remain in the isolated legacy adapter, with its existing
process, replay and receiver fences. Do not invent missing host, distro or workspace
kind fields. A manifested legacy writer cannot overwrite an address already owned
by a canonical row; canonical admission also refuses an occupied legacy address.
Neither direction guesses that two independently addressed observations are one owner.

## Contract without premature serving

The shared mutation core commits parents, child work, aliases, facts and tombstones
at one revision. Child identity is host-minted; provider task/tool identifiers are
scoped aliases, not authorization. Updates and stops require the expected invocation.
Aliases retain multiple lifetime bindings; retired bindings fence late observations
after child removal, reclassification, reparenting, or bounded invocation-history decay.
Snapshot restoration precedes replay; the store does not compare revisions across
unrelated owner epochs.

Record counts, invocation history and complete serialized snapshots have named limits.
A mutation that would exceed them fails atomically; projection truncation never
silently evicts owner history. Admission reads bounded child/alias queries without
cloning the complete snapshot.

Canonical child records preserve all existing kinds, states, live/settled membership,
outcomes and optional metadata. Legacy subagents are a bounded agent-only projection;
their required `startedAt` comes from host `firstObservedAt`. Projection limits do
not evict canonical records. One child-freshness rule downgrades active evidence to
`unverifiable` when either parent evidence is stale or transport is unverifiable;
neither condition proves completion or settlement.

The required Vitest suite enforces the current-producer legacy allowlist and the
empty-before-advertise gate. The complete run/child serving contract is not advertised
while current producers still depend on that adapter. Capable-host legacy ingress
is refused, not treated as a fallback writer.

## Remaining cutovers

- PR 2B binds trusted PTY/relay scope and hands ownership over atomically, retiring
  current producers from the legacy manifest.
- PR 2C admits full provider child observations before lossy summaries and supplies
  structured turn/completion clocks.
- Reader cutover requires whole-row delivery parity and capability negotiation.
  Until then, keep `StructuredAgentSessionStatusBridge` and the main structured-row
  publication filters: the bridge still supplies the live native-chat children.
- Pane-only old clients retain their existing successor-fact limitations. A legacy
  projection does not grant those clients canonical identity or action authority.
