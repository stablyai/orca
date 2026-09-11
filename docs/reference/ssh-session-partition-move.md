# Moving SSH workspace session state into its own partition

A worktree's durable session state (terminal tabs, editor files including unsaved drafts, browser
workspaces, tab groups, layouts, visit recency) is stored per execution host. `local` is the legacy
single blob; `runtime:*` and `ssh:*` each own a partition under `workspaceSessionsByHostId`.

SSH worktrees were split across two of these: the renderer wrote `local`, the main-process runtime
read-modify-wrote `ssh:<targetId>` (#12723). Neither reader reunited them, so whatever landed on
the unread side round-tripped as **absence**, and the `replace-session` upload converted absence
into deletion on the host (#12721, #18173).

The repair moves SSH state into `ssh:<targetId>` on both sides. It ships in **two releases**, and
the ordering is load-bearing.

## Why two releases

Both halves are needed for the end state, but only one of them is the fix:

- **Reading both partitions is the repair.** `mergeDirectSshRemoteWorkspaceSession` can only refuse
  to delete tabs _this client actually holds_ — hydrating them out of `ssh:<targetId>` is what arms
  that defence. With the read alone, an older client's empty publish no longer deletes anything and
  this client republishes the real list.
- **Moving the write is cleanup.** It collapses the double-ownership so one workspace stops being
  written twice.

Shipping the write move in the same release is what a downgrade cannot survive:

1. Every previously shipped build reads SSH session state out of `local` alone, and never
   enumerates `ssh:*` partitions.
2. A client that has moved the rows therefore looks **empty** for every SSH workspace on the older
   build — including unsaved `dirtyDraftContent`.
3. That build's publish then **omits** the workspace, and the relay applies `workspace.patch` /
   `replace-session` as a **wholesale snapshot overwrite**
   (`src/relay/workspace-session-handler.ts`), so the host snapshot forgets it too.

**Exposure is launch-and-quit**, not "use an SSH workspace". Routing derives from the persisted
repo catalog (`buildRepoHostById` over `state.repos`), so an offline target with no active
multiplexer still moves on the shutdown checkpoint.

### What is and is not lost

Measured, so the severity is not overstated:

- Client-side this is **invisibility, not destruction**. `parseWorkspaceSessionsByHostId` keeps any
  valid non-`local` host id, in the older build too, so the `ssh:<targetId>` partition survives the
  downgrade on disk and returns on re-upgrade.
- **Running remote agents are not reaped.** There is no path from a lost host-snapshot entry to a
  `pty.kill`.
- The older build publishes an **omission**, not `path: []`. It is not the authoritative-empty-list
  shape of #12721, and the next pull reads omission as `unverifiable`.
- The unrecoverable residue is therefore only what lived in the host snapshot and **never** in this
  client's `ssh:*` partition — tabs created by another paired device, or minted host-side while
  this client was away.

### Rejected alternatives

- **Dual-write a compatibility copy into `local`.** A populated base `tabsByWorktree` row is
  exactly what makes `workspacesTheBaseOwns` refuse to adopt, so this silently disables the
  adoption repair it ships alongside.
- **Leave the legacy `local` copy behind instead of replacing it.** Same trap, same reason.
- **A marker the older build would happen to honour.** Every input to its publish gate is host- or
  connection-derived (`hydratedTargetIds`, `expectedRevision`, `hostObservationToken`,
  `getActiveMultiplexer`); nothing on local disk reaches it. And the export inverts: making a
  worktree fail to resolve _excludes_ it rather than withholding the publish, which produces the
  damaging empty export.

## Release N (this change)

Reads `ssh:<targetId>`, keeps writing SSH state to `local`.

- `clientWorkspaceSessionWritePartitionHostId` in `src/shared/workspace-session-partition-owner.ts`
  maps `ssh:*` back to `local`. Two call sites: `sessionPartitionHostFor`
  (`workspace-session-host-contention.ts`) and the routing tail of `buildHostSessionRouting`
  (`workspace-session-host-persistence.ts`).
- The main-process runtime is unchanged — it already wrote `ssh:<targetId>` before any of this.

## Release N+1 checklist

**Fleet condition: do not ship until release N is broadly adopted.** N+1's safety is exactly that a
user downgrading from it lands on a build that already reads `ssh:*`. Any still-running build older
than N has the full exposure above.

1. Delete `clientWorkspaceSessionWritePartitionHostId` and both call sites; they revert to
   `workspaceSessionPartitionHostId`.
2. Flip these four assertions, each of which carries a pointer to this file:
   - `workspace-session-ssh-partition-round-trip.test.ts` — "routes the reunited workspace to the
     partition every shipped build reads": `LOCAL_EXECUTION_HOST_ID` → `SSH_HOST_ID`, and rename it
     back to "…to the partition that owns it".
   - `workspace-session-ssh-partition-round-trip.test.ts` — "writes an SSH workspace emptied by
     this build into the partition it writes to": swap the `local` / `SSH_HOST_ID` expectations.
   - `workspace-session-host-contention.test.ts` — "keeps an SSH claimant out of the rotating
     runtime partition": `LOCAL_EXECUTION_HOST_ID` → `SSH_HOST`. Keep the `not.toBe(RUNTIME_HOST)`
     assertion; it is the invariant and holds in both releases.
   - `workspace-session-host-contention.test.ts` — "does not strand the runtime co-claimant when
     the SSH row is written": the SSH row moves from the local write (`hostId === undefined`) to a
     `SSH_HOST` write.
3. Release-note line: _"SSH workspace session state now persists in its own store partition.
   Downgrading below &lt;release N&gt; after this update will hide SSH workspaces' tabs and editor
   state until you upgrade again."_
4. Fix, or accept with eyes open, the swallowed partition write in `patchWorkspaceSessionByHost`:
   the awaited `local` patch is what removes these rows from `local`, while the partition write
   meant to receive them is `void`-ed with a `console.warn`. Today that only risks `runtime:*`
   rows; from N+1 a swallowed rejection loses an SSH workspace's tabs and unsaved drafts outright.
