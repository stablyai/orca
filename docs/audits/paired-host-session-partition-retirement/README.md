# GUI unpair: retire an unowned paired-host session partition

> **Stale proof — regenerate before merge.** The checked-in hashes, patches, and Node/Electron
> reports below were computed on a branch stacked on #21113, and they fence that PR's
> `session-empty-terminal-tab-retirement.ts` / `empty-terminal-tab-retirement-owner.ts` as present
> in every variant, including `main-before`. This branch is now rebased directly onto `main`, where
> those files do not exist, and the renderer-admission failure behaviour described below has since
> been changed to fail open. `sources.cjs` will therefore refuse to load until all four variant
> graphs, the three patches, and both runtime reports are regenerated against `main`. The prose in
> this file has been corrected to describe the shipped code; the recorded numbers have not.

Related report: [#12241](https://github.com/stablyai/orca/issues/12241). This artifact demonstrates retained client profile state after explicit GUI removal. It does not measure RSS or attribute the memory in #12241 or #19831 to this mechanism alone.

## Finding and change

The actual GUI removal handler removes the saved pairing and retires its transport, but previously kept the matching `workspaceSessionsByHostId` entry in the main Store and profile file. Repeated pairing/removal accumulates distinct environment IDs. Deleting that entry alone is insufficient: all four renderer session-write channels can recreate it. An async legacy-recovery rollback can also recreate an explicitly removed entry and reopen an existing-partition admission fast path.

The fix removes the exact `runtime:<removed environment ID>` partition on GUI unpair when current main namespace custody does not require it. Renderer ingress admits a missing runtime partition only for an exact saved environment ID or current main-owned namespace. Existing partitions, local, and direct SSH retain their fast paths. The async recovery catch skips rollback into a partition that is now absent. No new cache, timer, tombstone, wire field, or process-liveness judgment is introduced.

## Reproduce

Run from the repository root with installed working dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/paired-host-session-partition-retirement/reproduce.mjs
```

An optional output-path argument writes the report elsewhere. For Electron, invoke its installed executable with this script and output path, setting `ELECTRON_RUN_AS_NODE=1` and `ORCA_BACKGROUND_LAUNCH=1`. No windows, network, or native PTYs are created; Electron/browser transport boundaries are inert. Store, pairing files, registered IPC handlers, runtime controller, browser projection, and recovery persistence are actual source.

Both checked-in runtime reports contain **78 passing cases**: 13 cases for each current/main × before/fixed/without-rollback phase. Node 24 and Electron 43 / Node 24 produce the same state results:

| Control                                                                           | Before       | Fixed      | Fixed except rollback guard |
| --------------------------------------------------------------------------------- | ------------ | ---------- | --------------------------- |
| 32 pair/write/unpair/late-patch cycles: memory / flushed disk / reload partitions | 32 / 32 / 32 | 0 / 0 / 0  | 0 / 0 / 0                   |
| Catalog rows after cycles; transport invalidations                                | 0; 32        | 0; 32      | 0; 32                       |
| Four late renderer write channels recreate an absent partition                    | yes          | no         | no                          |
| Failed `exited` recovery recreates partition after owner removal/unpair           | yes          | no         | yes                         |
| Failed `adopted` recovery recreates an absent partition                           | no           | no         | no                          |
| Existing local/SSH/runtime adopted rollback restores its record                   | yes          | yes        | yes                         |
| Sync admission with unreadable catalog: receipt / cold partition created          | true / yes   | true / yes | true / yes                  |
| Existing namespace sync write with the same unreadable catalog                    | succeeds     | succeeds   | succeeds                    |

The before-phase late-write and rollback controls explicitly **simulate deletion** of the exact partition, since the baseline has no deletion API. The repeated 32-cycle finding uses ordinary GUI removal without simulated deletion. Fixed phases use actual GUI removal. The omitted-rollback phase changes only the recovery module back to baseline. Main repo namespace collision, controller-selected unique historical alias, and a late browser projection remain preserved.

The permanent regression can also be run against the fenced baseline:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config docs/audits/paired-host-session-partition-retirement/before.config.mjs
```

Expected: **15 failures, 7 passes**. These cover late ingress, first-use catalog admission, same-name replacement, authority-read failure, repeated retirement, and new deletion/failure-order contracts. Normal repository config passes all 22 admission/removal cases. The nine new snapshot lifecycle cases, 12-case namespace suite, and seven relevant existing suites bring the targeted total to **94 passes**; see `validation.json` for commands.

## Source identity and publication portability

The recorded publication before graph matches prerequisite commit **718ead7ea9f6296d69ceb7d1460a3579116fe85f**, which is not an ancestor of `main`. Both recorded variants include that prerequisite's two-argument session registration, which this branch no longer carries. Regenerating the artifact must re-derive all four graphs from a named `main` commit. The review fixes are applied to both fixed graphs, including async admission error handling and snapshot release after profile persistence. `fixtureVariants` and the reports pin the current permanent fixture. The unrelated unused renderer test import that blocked CI was removed.

`source-versions.json` fences a union of **888 source paths**, with exact evaluated graphs of 857/860 modules for the original audit before/fixed and 883/886 for the publication before/fixed. The source graphs are complete; current dependencies are not silently imported behind a partial overlay.

`fix.patch` and `main-fix.patch` independently map their exact baselines to their fixes. `publication.patch` reversibly maps the current fixed graph to the main fixed graph. The loader accepts all four complete exact identities, rejects drift, reconstructs each variant in memory, and verifies every evaluated module hash. The runner checks all four reconstruction inputs, canonical CRLF reads, and exact evaluated graph equality. All patches have zero context. No Git checkout/ref or ignored notes are required to run the artifact. Reports record actual evaluated hashes and runtime versions.

The source overlays include the full evaluated `src/` graphs. Vitest configuration/setup files and the permanent baseline fixture are separately fenced. Installed Vitest/esbuild/diff and other `node_modules` remain working dependencies, not historical lockfile installs. Both fixed variants include the prerequisite's empty-terminal-tab retirement handler. This is a source-compatibility control on named main, not a claim that a packaged historical application was launched.

## Ownership and failure boundaries

- [GUI removal](../../../src/main/ipc/runtime-environment-connectivity-handlers.ts) establishes custody before catalog mutation, then starts existing transport/browser retirement before Store deletion. A custody lookup error is caught and treated as custody held: the unpair still completes and the partition is preserved, because an unreadable verdict is not evidence that nothing owns the namespace. A later deletion error surfaces after existing retirement has started.
- [Renderer admission](../../../src/main/ipc/renderer-workspace-session-admission.ts) uses exact saved IDs, never display names. Existing-partition/local/direct-SSH writes do not read the pairing file. [Session IPC](../../../src/main/ipc/session.ts) and [shutdown staging](../../../src/main/ipc/renderer-shutdown-checkpoint.ts) catch only new admission lookup failures, and they fail open: the write proceeds, synchronous receipts still report success, and the failure is logged. A resurrected partition is recoverable on the next unpair, whereas a dropped session write is not. Actual Store exceptions retain prior semantics.
- [Namespace custody](../../../src/main/runtime/runtime-workspace-session-namespace-custody.ts) reuses the actual runtime controller's alias resolution. Historical main repo stamps, current explicit folder custody, and a unique controller-selected older alias remain valid. Local/SSH workspace-ID collisions and ambiguous aliases do not supply runtime custody. Folder host stamps are deliberately stripped during Store loading by `src/shared/folder-workspaces.ts`; folder tests declare an **in-memory** main stamp and do not claim persisted historical folder custody.
- [Exact Store removal](../../../src/main/persistence/loading-store/session-host-partitions.ts) refuses local/SSH deletion, invalidates existing metadata-prune inputs, and schedules the normal save. If unshared snapshot refs remain, it flushes the profile before deleting only profile-local snapshot files. Shared refs and legacy fallback files remain; failed or frozen saves retain the files. [Recovery rollback](../../../src/main/runtime/runtime-legacy-worker-terminal-recovery-persistence.ts) checks partition presence. It preserves the existing field-level merge for a remaining partition; it is not an incarnation fence for a partition deleted and recreated with the same ID before rejection.

Audited main writers resolve controller ownership afresh or write local/direct-SSH bindings. Synchronous terminal retirement cannot interleave a GUI removal between its read and rollback. The async recovery path was the demonstrated absent-partition bypass. A missing-repo browser callback currently routes to local, not the retired runtime namespace; that separate existing behavior is not changed. Explicit profile transfer/import is outside this removal lifecycle.

## Limits

- GUI removal is not an atomic pairing-file/profile-file transaction. The disk/reload control explicitly joins `Store.flushOrThrow()`. Removal without exclusive snapshot refs uses the normal scheduled save. A crash or save failure before that save can leave old disk state; the GUI receipt does not guarantee profile deletion on disk.
- CLI `environment rm` and ephemeral-environment cleanup remove catalog rows directly and do not use this GUI boundary. Existing historical namespaces are not swept merely because a pairing is absent.
- Renderer folder/tab/shadow objects and in-flight hydration are separate owners. Admission prevents them from recreating an explicitly retired pure mirror in Store; it does not free those renderer objects. When the pairing catalog or namespace custody cannot be read at all, admission fails open, so a retired partition can be recreated until that read recovers.
- A main-owned namespace remains preserved even when its suffix equals the removed saved-environment ID. The change neither terminates remote work nor treats loss of contact as process death.
