# Shared historical source for cross-version tests (P2)

Cross-version tests extract historical releases under each worktree's
`tests/e2e/.cross-version-checkouts`. Previously, branches testing the same release each
retained a full copy. Local tests now prepare one read-only source seed and share its file
data with each worktree's independent import directory.

## How it works

Seeds live under `<git-common-dir>/orca-cache/release-source/format-8/<commit>`.
The resolved commit and extraction format identify the source, including its rewritten imports.
The common Git directory lets sibling worktrees reuse the same seed without scanning them.
Existing local checkouts remain in place; the new format creates fresh import directories.

Missing-package stand-ins depend on the current branch's dependencies, so each worktree
creates those locally. Mutable copies of current-branch modules also remain local.
The existing lock, staging directory, and rename transaction publishes complete seeds and
import directories. Invalid stamps, missing protocol source, or invalid package metadata
cause rebuilding or ordinary local extraction.

macOS uses APFS clones. Linux tries reflinks, then read-only hardlinks. Copies preserve the
seed's read-only permissions; these historical files are never edited by the harness.
Windows uses independent copies because removing read-only hardlinks can change permissions
on surviving links. Unsupported sharing falls back to a private copy. If the optional shared
cache fails, the harness extracts locally and continues the test.

The current format retains at most eight seeds, ordered by recent use. A shared lock covers
publication, copying, and eviction, so cleanup cannot delete a source while another test
copies it. Copying and permission changes are asynchronous so the lock heartbeat keeps running.
Interrupted staging directories are removed on the next use. Retention only touches the
current format; older implementations may still be using other formats. Eviction leaves
already-created import directories usable.

## Controls and scope

Sharing is enabled for ordinary local cross-version tests. Set
`ORCA_DISABLE_SHARED_RELEASE_CACHE=1` to keep ordinary local extraction. CI and explicit
`cacheRoot` options remain isolated unless a caller explicitly supplies `sharedCacheRoot`.

This only changes test tooling. It adds no development-server task or background worktree
scan. Sharing does not migrate or delete existing local caches. Tests running on a remote host use that
host's repository and filesystem; no client filesystem or remote protocol is involved.
Folder contexts without a Git repository cannot provide a historical release checkout.

## Cleaning up older historical caches

First stop cross-version tests in all this repository's worktrees, then preview historical-cache
cleanup across the registered local worktrees and shared source cache:

```sh
pnpm reclaim-space --tests-stopped
```

The default selects stamped release checkouts older than 30 days, including previous extraction
formats. Answer `Y` after the preview to apply it, or run the same selection directly:

```sh
pnpm reclaim-space --apply --tests-stopped
```

Use `--release-cache-min-age-days 7` for a shorter retention window, or `--release-cache-min-age-days 0` to select all
recognised completed release checkouts. `--repo DIRECTORY` selects another local repository.
Each run rescans and rechecks eligibility; it does not apply a saved preview.

This is manual because older harnesses do not hold a lease while importing source. Locks prevent
deletion during publication or shared-source copying, but do not prove that a completed checkout
is unused. Local checkout age uses directory modification time, which ordinary reuse does not
refresh; shared seed timestamps reflect recent copying. `--tests-stopped` acknowledges that the
caller has stopped consumers; it does not detect them.

The script checks matching commit/format stamps, skips symlinked cache paths and future formats,
and leaves mutable `working-tree` copies, source, dependencies, and worktree registrations alone.
It reports logical bytes rather than promised disk savings: another clone may retain the same
blocks. Deleted historical source rebuilds on the next test run. Run the command on the execution
host for SSH repositories. The same manual command also performs P1's Electron maintenance;
automatic dev-bundle sweeps exclude historical test cache cleanup.

## Measurement and validation

A disposable macOS/APFS run against `v1.4.190` compared ordinary extraction with two separate
local caches using one shared seed. Each import tree contained 8,175 files. APFS private file
allocation was measured after all three views existed, without following symlinks.

| Method                           | Elapsed time | Private file data per import directory |
| -------------------------------- | ------------ | -------------------------------------- |
| Ordinary extraction              | 4.64 s       | 68.79 MiB                              |
| Shared source, creating the seed | 22.06 s      | 44 KiB                                 |
| Shared source, reusing the seed  | 1.33 s       | 44 KiB                                 |

Shared blocks still occupy approximately one source copy. Private bytes exclude those blocks
and filesystem metadata, so they are not the total footprint. The cold seed costs extra work;
one timing sample on a busy machine does not establish a speed guarantee. Deleting the seed
left the other import directory readable. No existing worktrees were cleaned up.

Tests cover concurrent publication, lock heartbeats and eviction, independent branch stand-ins,
corrupt seeds, fallback, the opt-out, and preserved read-only files. Run them with:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm test tests/e2e/cross-version-wire/release-source-cache.unit.test.ts tests/e2e/cross-version-wire/release-source-retention.unit.test.ts tests/e2e/cross-version-wire/release-checkout.unit.test.ts tests/e2e/cross-version-wire/release-checkout-tree.unit.test.ts tests/e2e/cross-version-wire/release-missing-packages.unit.test.ts config/scripts/space-sharing-copy.test.ts
```

## P3 remains an experiment

P3 shares the tracked source of new Orca worktrees. It requires independent writable files,
Git indexes, and matching checkout settings, and has more compatibility risk than P2's
immutable test source. The APFS experiment demonstrated substantial storage savings but
variable creation time and stays out of this change. Its code, measurements, and design notes
are preserved on `nwparker/tracked-source-sharing-experiment`; [the draft PR is closed](https://github.com/stablyai/orca/pull/27618).
