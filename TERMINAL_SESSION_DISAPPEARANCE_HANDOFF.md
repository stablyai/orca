# Terminal session disappearance: engineering handoff

## Start here

This PR hands off the investigation and immediate safety fixes for the 2026-08-23 terminal-session
disappearance incident. It also records the unresolved architectural question: how a persisted PTY
should identify the exact process that owns it across Orca restarts and updates.

The short version is:

> Orca sometimes treated “I cannot find the daemon that owns this terminal” as “the terminal
> exited.” It then deleted the terminal's saved UI state. The current branch prevents that data
> loss, but it does not yet replace the underlying daemon-identity architecture.

## Background

During a failed application update, Orca restarted several times. Protocol-v36 daemon PID `6835`
became unavailable for a reason the retained evidence cannot identify, and PID `26391` became the
new v36 daemon.

Starting `26391` was reasonable. A new compatible daemon is needed for new terminals when the old
endpoint cannot be used. The problem was what happened to persisted terminals whose exact owner
could no longer be reached.

Orca's daemon endpoint is primarily named by protocol version, for example `daemon-v36.sock`.
Protocol 36 is like a language both processes speak; it is not the identity or address of one
specific daemon process. Once a different v36 daemon occupied the endpoint, the app could not
reliably reconstruct which exact daemon incarnation owned every historical PTY.

## User impact

The stable before/after profile comparison found:

| Measure | Result |
|---|---:|
| Removed terminal rows | 158 |
| Affected worktrees | 61 |
| Represented pane PTYs | 191 |
| Primary PTYs with explicit exit/kill evidence | 20 |
| Primary PTYs with no authoritative exit evidence | 138 |
| Unverifiable primary PTYs with surviving history | 138 |

At least 41 detached agent processes were still alive in the post-incident process observation.
That observation does not prove every affected process survived, but it proves the incident was
not simply “all terminals exited.” Much of the damage was deletion of persisted topology and UI
records.

## What actually failed

There were two destructive software paths and one separate physical-kill path.

### 1. Main converted missing routing authority into `false`

On terminal visibility resume, the renderer asked whether a saved PTY still existed. The old path
used boolean-oriented `hasPty()` behavior. When no currently registered daemon adapter recognized
the PTY, the router returned `false`.

That answer only established:

```text
the current adapter registry cannot locate the session
```

The renderer interpreted it as:

```text
the owning host proved that the session exited
```

It then ran the PTY-exit close path and persisted the terminal row and unified tab as deleted.

### 2. Renderer cleared a binding after an owner-unverified reattach

The first guarded build fixed tri-state liveness in main, but live recovery exposed another path.
Main correctly reported `terminal_pane_owner_unverified`; the renderer then received no reattach
result, cleared the saved binding, and could start a replacement shell. The displayed toast said
the old session was left untouched even though the binding was not preserved.

The second branch fix preserves the old binding and refuses to fresh-spawn solely because owner
authority is unavailable.

### 3. Missing-worktree cleanup killed a separate subset

A burst of 15 graceful daemon kills strongly matches a successful-but-partial worktree scan being
used as destructive authority. Those are real terminal stops and need an independent fix. They do
not account for the bulk of the 158 removed rows.

## Why PID `6835` is not the root cause of the bulk loss

PID `6835` becoming unavailable could strand raw PTYs that it actually owned. It cannot explain
the entire incident set:

| Frozen primary-PTY verdict | Latest event from `6835` | Latest event from another daemon PID |
|---|---:|---:|
| `unverifiable` | 5 | 133 |
| `exited` | 15 | 5 |

Historical event provenance does not prove current liveness. It does show that loss of one daemon
cannot be used as exit evidence for the 138-session unverifiable set.

Recovery-v2 supplied a useful control case: a newer app retained the still-live hourly daemon PID
`26391`, despite its older build metadata, and preserved all 131 complete affected topologies that
remained in tracked worktrees. Same-protocol app/daemon version skew is therefore supported and is
not inherently destructive.

## Confirmed versus unknown

### Confirmed

- The intended ad hoc update did not install during the incident.
- The installed and intended bundles both used daemon protocol 36 and state schema 1.
- PID `6835` stopped being reachable and PID `26391` became the current v36 daemon.
- The boolean liveness path could convert missing adapter registration into an exit decision.
- PTY-exit handling could delete both persisted terminal models without killing the underlying
  descendant process.
- The renderer had a second owner-unverified binding-clearing defect.
- Only 20 primary PTYs have explicit latest exit/kill evidence in the frozen catalog.
- Recovery-v2 preserved topology and successfully continued one saved Codex provider session in
  place under a new raw session incarnation.

### Unknown

- What stopped PID `6835`.
- Whether every one of the 158 deletions traversed the same renderer close callback.
- Which historical raw PTYs or descendants remained live at each later observation.
- Whether a missing route meant the owner was dead, unreachable, omitted from registration, or
  hidden behind same-protocol endpoint replacement for each individual session.

Unknown must remain `unverifiable`; it must not be rewritten as `exited`.

## Immediate fixes included on this branch

### `25ae8e8edf`: preserve unverifiable terminal sessions

- Waits for local PTY-provider startup before answering liveness.
- Prefers tri-state `probePtyLiveness()` over boolean `hasPty()`.
- Returns `null` when the provider or route cannot authoritatively answer.
- Allows destructive reconciliation only on literal authoritative `false`.

### `bd09097708`: preserve owner-unverified terminal bindings

- Recognizes `terminal_pane_owner_unverified` during reattach.
- Preserves the saved pane/tab PTY binding.
- Prevents the missing reattach result from being treated as a stale/dead session.
- Avoids starting a replacement shell over an uncertain old owner.

These commits are immediate data-loss guards. They are not the permanent daemon-identity design.

## Fundamental problem

The current architecture partially conflates three different concepts:

```text
protocol compatibility: “can we speak?”
endpoint slot:          “where is the current v36 daemon?”
owner identity:         “which exact process owns this PTY?”
```

A persisted session needs the third answer. Asking every currently registered compatible adapter
whether it recognizes an ID is not a durable ownership model.

The permanent invariant should be:

> Only the matching execution host, owner incarnation, and session incarnation may establish that
> a raw PTY is live or exited. Missing routing/contact is `unverifiable`.

## Rough permanent solutions

The architecture document compares two approaches in detail.

### Approach A: incarnation-addressed daemons

Give every daemon process a UUID and unique endpoint. Persist that daemon incarnation with every
session. New sessions use a current compatible daemon; existing sessions always route to their
recorded owner.

```text
logical PTY -> session incarnation -> daemon incarnation -> unique endpoint
```

This is the smaller retrofit. It eliminates protocol-slot identity collisions and adapter-scan
ownership inference, but long-lived sessions may retain multiple daemon generations. If the
owning daemon crashes, its PTY masters are still lost.

### Approach B: stable PTY host plus replaceable control daemon

Move PTY ownership into one deliberately small, long-lived host. Keep fast-moving Orca behavior in
a replaceable control daemon.

```text
app -> replaceable control daemon -> stable PTY host -> PTYs
```

This bounds PTY-owning daemon accumulation and lets raw terminals survive app/control-daemon
replacement. It is a larger cross-platform refactor, adds an IPC hop, and makes the stable host a
single failure domain. If the stable host itself crashes, its PTY masters are still lost.

### Decision that remains

- Choose Approach A for the smallest safe ownership correction.
- Choose Approach B if a hard steady-state process bound and control-daemon crash survival justify
  the larger refactor.
- If PTYs must survive failure of the process that owns the PTY master, neither approach is enough;
  that requires per-session hosts or another independently surviving owner.

## Suggested next steps for the new owner

1. Review the immediate fixes independently from the permanent architecture decision.
2. Confirm whether product requirements include raw PTY survival across control-daemon failure,
   PTY-owner failure, or only app updates.
3. Measure the existing daemon's idle memory/CPU and the expected number of simultaneous protocol
   generations.
4. Select Approach A or B using the architecture document's comparison and performance gates.
5. Define the persisted owner schema, endpoint authentication, migration state machine, and
   mixed-version behavior before implementation.
6. Keep the legacy discovery path non-destructive during migration.
7. Fix missing-worktree teardown independently; do not couple it to daemon identity.

## Reading order and PR artifacts

1. [`TERMINAL_SESSION_DISAPPEARANCE_HANDOFF.md`](TERMINAL_SESSION_DISAPPEARANCE_HANDOFF.md) — this
   plain-language entry point.
2. [`PTY_DAEMON_IDENTITY_ARCHITECTURE_DESIGN.md`](PTY_DAEMON_IDENTITY_ARCHITECTURE_DESIGN.md) —
   permanent approaches, tradeoffs, migration, and acceptance criteria.
3. [`TERMINAL_SESSION_DISAPPEARANCE_INCIDENT_2026-08-23.md`](TERMINAL_SESSION_DISAPPEARANCE_INCIDENT_2026-08-23.md)
   — full incident timeline, causal analysis, and immediate fixes.
4. [`RECOVERY_CATALOG.md`](recovery/2026-08-23-session-disappearance/RECOVERY_CATALOG.md) — frozen
   per-session classifications and limitations.
5. [`POST_CUTOVER_RECOVERY_STATUS.md`](recovery/2026-08-23-session-disappearance/cutover-20260823T201851Z/POST_CUTOVER_RECOVERY_STATUS.md)
   — first guarded cutover, live accounting, and discovery of the renderer-side binding defect.
6. [`RECOVERY_V2_CUTOVER_STATUS.md`](recovery/2026-08-23-session-disappearance/cutover-v2-20260823T140110MST/RECOVERY_V2_CUTOVER_STATUS.md)
   — controlled upgrade and provider-continuation validation.

The PR intentionally excludes machine-specific app bundles, DMGs, live profiles, terminal-history
payloads, and large raw logs. The included documents retain the relevant counts, hashes,
limitations, and evidence locations without making the PR unsafe or impractically large.

## Scope boundary

Preventing application activation during an update window is intentionally out of scope for this
handoff. It is recorded in the incident timeline but should be handled separately from PTY owner
identity and liveness authority.
