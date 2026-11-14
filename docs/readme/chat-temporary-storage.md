# Chat storage and temporary data

`ORCA_CHAT_SCRATCH_DIR` contains persistent reports and attachments. Retaining a chat retains
that directory. It is not a disposable build directory.

Native chats with the inline visuals skill also receive `ORCA_CHAT_TEMP_DIR`, a private
directory on the executing host. A new provider launch gets a new directory. It can hold
disposable build output and test environments; never keep the only copy of source changes,
reports or user files there. Move final artifacts to scratch or the workspace before replying.
When visuals are unavailable Orca strips both inherited paths, preventing cross-chat writes.
This works on the execution host, including remote hosts, without client filesystem access.
Older hosts continue to provide only the scratch path.

Cleanup runs with the existing chat-storage sweep (after two minutes, then every six hours).
Only directories bearing Orca's ownership marker are considered. The owning Orca PID must no
longer exist, and the marker and all nested data must have been unchanged for seven days.
A live or uncheckable owner, recent changes, Git metadata, invalid markers, unreadable data,
symlink roots or an incomplete scan prevent removal. Nested symlinks are never followed.
PID reuse can conservatively retain old temporary data. Cleanup is retention-based, not a
hard filesystem quota; an active task can still fill its disk. Temporary files are disposable
after that retention period, including files from detached jobs that outlive Orca.

Preview and optionally reclaim the executing host's new managed temporary data:

```sh
pnpm reclaim-chat-temp --state-directory "/path/to/Orca/profile"
pnpm reclaim-chat-temp --state-directory "/path/to/Orca/profile" --json
pnpm reclaim-chat-temp --state-directory "/path/to/Orca/profile" --apply
```

The profile path is explicit: the command never guesses which local or remote profile owns
the data. `--apply` revalidates candidates and directory identity before removal. At most 20
directories are removed per run. Permission failures are reported, not treated as free space.
Per-entry allocated sizes count an inode only once; shared hardlinks and APFS clones mean
these are not guaranteed reclaimable bytes. Protected or incomplete scans may show no size.

Legacy `chat-scratch` contents are never silently migrated or deleted. They may contain user
reports and unmerged work mixed with old build caches. Audit and migrate them individually.
Managed provider homes, credentials, SQLite databases and chat history are outside this cleanup.
Compacting a conversation does not mean its append-only provider log becomes smaller.

Use package managers' existing shared caches, not private per-task stores. Orca's pnpm
configuration already enables a global virtual store outside CI. For old dependencies and
generated files in registered Git worktrees, use the existing [worktree storage maintenance](./worktree-storage-maintenance.md).
For removing worktrees themselves, use the existing workspace cleanup preview and its
dirty-file, unpushed-commit, active-agent and branch-preservation checks.

## Profile overview

```sh
pnpm storage:overview --state-directory "/path/to/Orca/profile"
pnpm storage:overview --state-directory "/path/to/Orca/profile" --json
```

This read-only command reuses the workspace space scanner and its cancellation/capacity limits.
It compares bytes referenced by all paths with unique allocated bytes, counting hardlinked
history once within each top-level folder and once across the profile. Top-level folders
can overlap through hardlinks, so use the profile total rather than summing folder totals.
Symlinks are counted but never followed. Skipped entries are explicitly marked incomplete;
a capacity error is a failed scan, not zero usage. Concurrent writers can change a snapshot.
The scan does not read file contents, tokens, credentials or transcript payloads. APFS clone
sharing and hardlinks outside the selected profile are not resolved, so allocated bytes do
not imply reclaimable bytes. The overview does not select files for deletion.
