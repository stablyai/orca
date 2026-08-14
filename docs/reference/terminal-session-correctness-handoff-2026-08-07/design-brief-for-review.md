# Design brief — terminal session ownership & transport

Review artifact. Repo: Orca (Electron + renderer + relay). Everything below marked
**[V]** was verified by reading the code at the cited location. Everything marked
**[R]** is agent-reported and only spot-checked. Treat **[R]** as a lead, not a fact.

---

## 1. The product problem

Orca runs terminals on four "routes":

| Route                 | Provider                                        | Survives app restart       |
| --------------------- | ----------------------------------------------- | -------------------------- |
| local in-process      | `LocalPtyProvider`                              | no                         |
| local daemon          | `DaemonPtyAdapter` (swapped into the same slot) | yes                        |
| direct SSH            | `SshPtyProvider` → remote relay                 | yes, within a grace window |
| paired remote runtime | not an `IPtyProvider`; runtime RPC              | yes                        |

Reported failures:

1. **Pane cardinality growth (STA-3077).** SSH reconnect: 2 terminals → 19 → 20.
   Most are panes the user never opened. Remote host fills with unused shells.
2. **Duplicate agent resume.** A coding agent gets resumed twice, two processes
   writing one conversation file. One report reached five.
3. **Blast radius.** One PTY failing to re-prove its output stream could drop the
   whole host connection, killing every pane, file transfer and git command on it.

## 2. Verified facts (the evidence base)

**[V] Dispatch is a substitution for daemon, a parallel registry for SSH.**
`src/main/ipc/pty.ts:932-941`:

```ts
function getProvider(connectionId) {
  if (!connectionId) return localProvider // local AND daemon — one slot
  const provider = sshProviders.get(connectionId) // SSH — separate map
}
```

The daemon is installed by `setLocalPtyProvider(routedAdapter)`
(`src/main/daemon/daemon-init.ts:1031`) and adds **zero** branches to the shared
spine. The paired runtime is encapsulated behind a `PtyTransport`. SSH is neither —
it rides the local path carrying a `connectionId` tag.

**[R] That tag leaks:** ~199 remoteness branches in main (52 in `pty.ts`, 143 in
`orca-runtime.ts`), ~191 in the renderer, plus 25 `instanceof` provider checks.
The `remote:` predicate is re-declared 5 times in the renderer.

**[V] The transport dropped the half that makes it persistent.**
`src/main/ssh/relay-protocol.ts:34`:

```ts
export const MessageType = { Regular: 1, KeepAlive: 9 } as const
```

The 13-byte frame header was copied from a well-known persistent protocol, but
only 2 of its 9 message types were kept. Dropped: `Control`, `Ack`, `Disconnect`,
`ReplayRequest`, `Pause`, `Resume`, `None`. The surviving ACK field feeds only
`unackedTimestamps` (`ssh-channel-multiplexer.ts:107,448,596`), a seq→timestamp map
read solely by the death timer. **Nothing is retained at the transport layer;
nothing is replayed.** Consequence: three layers above it each rebuilt
retain-and-replay independently (SSH credit ledger, runtime-RPC source-range
ledger, daemon batcher — the last deliberately lossy).

**[V] Method layer is transport-agnostic.** `runtime/rpc/methods/terminal.ts` and
`git.ts` have 0 SSH references; `files.ts` has 27.

**[V] Three durable records exist, plus a fourth copy on the host.**

|                                       | key                       | pane identity is              |
| ------------------------------------- | ------------------------- | ----------------------------- |
| PTY binding (`WorkspaceSessionState`) | `(hostId, tabId, leafId)` | **the key**                   |
| `SshRemotePtyLease`                   | `(targetId, relayPtyId)`  | **optional payload**          |
| `SshPtyConsumerRecovery`              | `targetId`                | n/a (per-target resume token) |
| relay `attachIdentity`                | per PTY, in-memory        | compare-only                  |

**[R] ~374 lines of pure lease↔binding reconciliation in `persistence.ts`**, and 9
enumerated states where the records can disagree. Example of an independent latent
bug: absence of a lease means "restorable" in `isRestorablePtyBinding` but "not
restorable" in `hasRestorableSshRemotePtyLease` — so whether a binding survives
depends on whether a _sibling leaf_ had a binding.

**[V] The relay holds nothing durably.** Its PTY table is
`private ptys = new Map<string, ManagedPty>()` (`src/relay/pty-handler.ts:356`).
No relay-side persistence of PTY state exists. `pty.serialize`/`revive` hand state
to the _client_ and take it back; `revive` requires the original PIDs to still be
alive. On PTY exit the entry is deleted with no tombstone.

**[V] Pane identity is write-only over the wire.** `listProcesses` and `attach`
never return `paneKey`/`tabId`/`leafId`; `attach` only compares and throws
`identity mismatch`. The one RPC that returns identity (`pty.serialize`) has
**zero production callers** — test files only.

**[V] The client's lease is consulted from a synchronous, offline, disk-only path.**
`hasRestorableSshRemotePtyLease` is called inside `setLocalWorkspaceSession`
(`src/main/persistence.ts:6465`), a synchronous `void` method invoked on every
renderer session publish including during quit (`:6287`, `:6351`).

## 3. Alternatives already refuted

**A. Merge the lease into the pane binding.** Blocked by two load-bearing
properties: a lease must be able to name a live shell **no pane owns** (the actual
STA-3077 field state; reattach enumerates these), and a lease **outlives** the
binding — expiry deletes the binding and then authorizes recreating a shell for 30s
(`SSH_PANE_RECOVERY_GRACE_MS`, `orca-runtime.ts:1771`).

**B. Delete the lease; make the remote host authoritative.** Refuted. The host has
no durable state, cannot be queried for pane identity, has no notion of "recently
died, replacement authorized", and is by construction unreachable exactly when the
record is needed. Decisive: you cannot replace a synchronous local disk read during
quit with an RPC to a host that is down.

**C. A second "authority architecture" beside the existing one** (+60,903 lines,
394 new files). Rejected earlier: it fixed none of the three root causes.

## 4. The design under review

### Plane 1 — data plane (adopted from a separate proposal)

Restore a delivery guarantee at the transport, then collapse what was rebuilt above
it. Roughly: capability handshake; one delivery-identity type; one credit-ledger
implementation parameterised by unit and limit; one chunk-and-ack primitive; one
lane vocabulary; binary PTY payloads reusing the binary terminal frame Orca already
ships to mobile; prebuilt native binaries so first connect stops needing a compiler;
then teach the relay to listen on a loopback WebSocket, forward that port, and let
the _same_ client serve the SSH route — after which SSH is "launch + access" only.

### Plane 2 — control plane (proposed here; the reviewed contribution)

The lease answers two different questions with one record keyed for neither:

- "which shell does this pane own?" → wants a **pane** key
- "which shells exist that nobody owns?" → wants a **pty** key

Proposal: split by question.

- **Ownership record**, keyed `(host, pane)` — the _same_ key local already uses.
  Transport-specific payload (lease state + timestamps for SSH; nothing extra for
  local). Makes "one pane, one live shell" structural rather than enforced.
- **Orphan inventory**, keyed `(host, ptyId)` — live shells with no owner. Feeds the
  reattach work list and the disconnected-cleanup UI.
- The 30s recovery grant becomes a terminal state on the pane-keyed record.
- Offline consumers keep reading local disk synchronously, unchanged.

Claimed payoff: the ~209 lines of supersession/ranking/rollback/dual-matchers exist
_only_ to bolt a pane-keyed constraint onto a pty-keyed record, and become
unnecessary.

## 5. Historical defect, now resolved

This defect was resolved by the shared `bindPaneShell` producer used by relay reattach and both
spawn handlers. Its mutation proof is recorded in
[S5](./new-design-goalposts.md#s5--the-superseded-pane-fence-is-live-on-the-reattach-path--proven).

## 6. Hard constraints

- **Cross-platform**: macOS, Linux, Windows (+ WSL). No `echo $$`/`ps` assumptions.
- **Folder workspaces**, not only git worktrees.
- **Remote wire compatibility**: clients and remote hosts update independently;
  mixed versions are normal. New optional field = safe; new stream opcode must be
  capability-negotiated (decoders drop unknown opcodes silently); changing what a
  host publishes reaches old clients with no wire change.
- **Git 2.25 baseline** for git-touching work.
- Durable on-disk state is also read by pinned older builds in cross-version tests.
- "Unknown is not dead": disconnect, timeout, absent inventory, and retry
  exhaustion must never authorize destroying a process.
- No `max-lines` lint disables.

## 7. What the review must answer

1. **Correctness holes.** Which cases does the Plane 2 design get wrong or fail to
   cover? Specifically: multi-window / multi-device on one host; app restart while
   disconnected; relay restart; host reboot; PTY exit during disconnect; two panes
   racing for one shell; migration from existing on-disk state; a pane deleted while
   its shell lives; the same worktree open in two windows.
2. **Simplicity.** Is there a _simpler_ design with the same correctness? Simpler
   means fewer code paths and fewer concepts, not merely fewer lines. Is the
   two-record split actually necessary, or is there a single-record formulation that
   survives the section-3 refutations?
3. **Migration.** Re-keying a durable record needs a story for existing state,
   partial writes, and rollback.
4. **Testability.** What oracle would fail if each guarantee were removed? A design
   whose guarantees cannot be falsified by mutation is not finished.
5. **Is Plane 2 even the right cut?** Attack the premise that data plane and control
   plane are separable here.
