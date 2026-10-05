# Editor draft recovery

Unsaved text has its own journal, independent of workspace layout and open tabs.
Closing a tab, removing a workspace, or losing the editor process leaves its last
checkpoint available through **Recover unsaved changes** in the command palette.
Startup offers a review when recovery copies have no open buffer.

The recovery dialog lists paths and owning hosts without loading draft bodies.
Selecting a draft loads a preview capped at 100,000 characters. **Recover copy…**
exports the complete text to a separate file and keeps the journal entry. Explicit
discard requires confirmation and checks the revision again. Currently open dirty
buffers cannot be discarded from this dialog.

## Capture and durability

- Text editors observe model changes without reading the entire document on each
  keystroke. Split panes share one model subscription and one full-text read at a
  checkpoint. Text is published after 150 ms of quiet input or within 500 ms of
  continuous input; saves, close, owner changes, and model disposal flush it first.
  Plain editors and single-file diffs mark their tab dirty immediately. Checkpoints
  reconcile the exact dirty state, including undo, against the loaded baseline.
- Plain-text and editable unstaged-diff buffers are checkpointed after 250 ms of
  inactivity, with a 500 ms deadline during continuous input. Rich-text and notebook
  serialization also has a 500 ms deadline. Storage latency can extend these times;
  only a completed transaction is acknowledged as durable.
- Each buffer has an independent ID and revision. Writes compare the expected
  revision, so delayed checkpoints cannot resurrect a saved or discarded draft.
  Saving retires only the exact text written successfully; newer edits remain dirty
  and recoverable. Closing retains a copy instead of retiring it.
- Editable sections in the combined changes view use the same journal. After the
  view closes, each unsaved section can be recovered as an independent file copy.
- Desktop writes run in one reusable worker, in transactions using SQLite WAL
  and `synchronous=FULL`. The file is `editor-recovery.sqlite` in the active profile's
  storage directory. Existing SQLite permission hardening covers its sidecars.
  The worker starts on demand, stays warm during active requests, and closes its
  database and thread after one second without requests. The next request reopens
  the same journal without importing old snapshots again. No committed draft needs
  to remain in worker RAM while the editor is idle.
- Browser clients use the `orca-editor-recovery` IndexedDB database, with separate
  metadata and content stores and strict transaction durability. Quota or disk
  failures leave previous checkpoints intact and present a retry action.

Lightweight input notifications start journal and compatibility-session deadlines
directly; publishing the later text snapshot does not restart those deadlines.
The recovery subscriber also observes draft-map identity changes. Checkpoints
inspect buffers, reuse captured metadata,
write only changed records, coalesce edits behind an in-flight write, and batch at
most 64 records and 4 MiB of estimated UTF-16 message text per transaction. A draft
larger than that text budget travels alone without truncation. Legacy imports use
the same limits. This avoids large cross-thread messages retaining excess resident
memory. Large drafts send only the replacement between their common prefix and
suffix after the first acknowledged snapshot. Small drafts, large replacements,
and major deletions send a full snapshot. Differences are computed at checkpoint
time, against acknowledged text, including when newer edits arrive during a write.

Desktop metadata, full bodies, and incremental edits use separate tables. Small
edits do not load or rewrite the unchanged body. A transaction compacts the body
after 64 edits or when inserted JSON text reaches half the current draft's UTF-8
size (with a 64 KiB minimum). Recovery replays bounded slices and joins once,
preserving every UTF-16 code unit. Browser transactions apply the same edits to
their content store. Both persistence subscribers reuse a timer until its deadline
instead of allocating and cancelling one for each keystroke.
Active copies retire after a matching successful save; closed copies remain
available for explicit recovery or discard.

Autosave follows input notifications even while the draft string has not changed.
It flushes pending text before writing and after the disk write completes, before
clearing the dirty flag. Older React snapshots cannot replace newer model input.
Model subscriptions and callbacks follow committed file and execution-host ownership,
including retained models and virtualized combined-view sections.

## Ownership and restore

Resource identity includes the execution host, workspace, runtime environment,
external SSH target, absolute path, and buffer kind. Equal paths on different hosts
cannot replace each other's drafts. Backups live on the client; the owning host
continues to perform file reads and writes. Recovery does not require a new remote
RPC method or a connected host to export a copy.

Restore overlays journal text onto existing session tabs without rebuilding their
layout. The original disk signature is preserved. A changed or unknown disk baseline
requires conflict verification before autosave, including after a crash. Recovery
does not write the original file automatically.

## Migration and rollback

On first use, dirty writable buffers from legacy session snapshots are imported
across all host partitions. Stable IDs make retries idempotent, and retired IDs
remain as tombstones. The source snapshots stay intact if import fails.
Desktop journal version 2 reads version-one bodies in place and moves each body
into separate storage on its next changed checkpoint. Older journal readers refuse
the new version; released builds can still use the compatibility session snapshot.

Session snapshots continue to include dirty text for older builds, alongside optional
recovery IDs, revisions, and buffer-kind fields. No paired-host upgrade is required.
Newer snapshot text takes priority over an older journal checkpoint and receives a
fresh checkpoint. Unknown future buffer-kind tokens remain readable in the session
schema. A future journal version is left untouched and the legacy session remains
available.

Legacy snapshots without recovery IDs cannot prove whether identical text was
already retired or edited again in an older build. Recovery favors preserving that
text. Copies created by combined-view sections are available through the new recovery
dialog; older builds do not have that interface. Desktop profiles and browser origins
have separate storage; switching either does not transfer the journal automatically.

## Validation and performance

Regression coverage exercises real transaction rollback, revision races, exact empty
and large Unicode text, worker termination after a commit, legacy import, future
versions, continuous typing, and edits during saves. Coverage also checks shared
checkpoints, deferred autosave, undo during a save, model swaps, stale React
snapshots, and interrupted owner renders. Hidden-renderer integration
tests exercise the recovery dialog, complete exports, combined-view editing,
browser storage, and a hard-killed app followed by an external disk change.

The pull request records repeated local comparisons against a pinned main snapshot,
covering persistence scheduling, committed checkpoints, process RSS and hidden-app
memory. Main has no independent journal, so checkpoint latency is added durability
work. Recovery still requires a worker and an acknowledged text reference; reducing
message sizes does not remove all additional RAM. A single oversized draft, restore
responses, compaction and compatibility-session snapshots can still carry larger
payloads. Local measurements do not establish keyboard latency or cross-platform
memory guarantees.
