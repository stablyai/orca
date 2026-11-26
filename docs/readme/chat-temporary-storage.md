# Chat storage and temporary data

`ORCA_CHAT_SCRATCH_DIR` contains persistent reports and attachments. Retaining a chat retains
that directory. It is not a disposable build directory.

Native chats with the inline visuals skill also receive `ORCA_CHAT_TEMP_DIR`, a private
directory on the executing host for disposable data: dependency installs, private caches,
source checkouts, build output and test environments. A chat keeps the same directory across
launches, so a restarted agent finds its environments again. Never keep the only copy of source
changes, reports or user files there. Move final artifacts to scratch or the workspace before
replying. When visuals are unavailable Orca strips both inherited paths, preventing cross-chat
writes. This works on the execution host, including remote hosts, without client filesystem
access. Older hosts continue to provide only the scratch path.

Cleanup runs with the existing chat-storage sweep (after two minutes, then every six hours):

- Removing a chat removes its whole temporary directory, like its scratch directory, including
  any Git checkouts in it.
- Inside a retained chat's directory each top-level entry ages on its own. An entry is removed
  once nothing inside it has changed for seven days, even while the chat stays in use. This is
  what bounds a long-lived chat that creates a new environment for every task.
- An entry with a `.git` file or directory at any depth is kept while its chat is retained, since
  a checkout can hold the only copy of unfinished work. If the chat's directory is itself a
  checkout, every entry in it is kept.

Size and file count never protect an entry: the directory is disposable by contract, and those
are exactly what the largest abandoned environments consist of. Orca writes an ownership marker
into each chat directory it creates; a directory without a valid marker is never removed.
Symlinks are never followed and an unreadable entry is left alone. An entry is judged by
modification and change times, so reading a cache does not keep it; a cache that is only read
for seven days is downloaded again. Before removing an idle entry the sweep moves it aside in the
same directory, so new writes by path cannot reach it, examines it again and puts it back if
anything changed meanwhile. An entry that cannot be moved, such as one in use on Windows, is
kept. A process that already has a file open inside the entry can still write to it until it is
removed. Cleanup is retention-based, not a hard quota: an active task can still fill its disk.

Preview and optionally reclaim the executing host's temporary data:

```sh
pnpm reclaim-chat-temp --state-directory "/path/to/Orca/profile"
pnpm reclaim-chat-temp --state-directory "/path/to/Orca/profile" --json
pnpm reclaim-chat-temp --state-directory "/path/to/Orca/profile" --apply
```

The profile path is explicit: the command never guesses which local or remote profile owns
the data. It cannot read the chat roster, so it only ages entries; directories of removed chats
are left to the running app. At most 200 entries are removed per run. Use the profile overview
below for sizes.

Legacy `chat-scratch` contents are never silently migrated or deleted. They may contain user
reports and unmerged work mixed with old build caches. Audit and migrate them individually.
Managed provider homes, credentials, SQLite databases and chat history are outside this cleanup.
Compacting a conversation does not mean its append-only provider log becomes smaller.

For old dependencies and generated files in registered Git worktrees, use the existing
[worktree storage maintenance](./worktree-storage-maintenance.md). For removing worktrees
themselves, use the existing workspace cleanup preview and its dirty-file, unpushed-commit,
active-agent and branch-preservation checks.

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
