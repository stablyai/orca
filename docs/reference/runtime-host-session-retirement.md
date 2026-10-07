# Removed paired-host sessions

Removing a pairing retires its client-side session partition only when the current main catalog
does not own that namespace. It does not stop processes on the remote host or declare them exited.
Local, direct SSH, and historical runtime namespace aliases remain separate authorities.

Before removing active state, Orca durably writes a private recovery file under the active profile's
`retired-runtime-sessions/` directory, beside `profile-state.db`. Each version-1 JSON file records
the execution host, the exact session (including unsaved editor text and disk signatures), and
available referenced terminal scrollback, including the full stored buffer rather than the smaller
replay window. Missing, unreadable, or oversized legacy snapshots are listed explicitly and their
source files are kept. Only successfully archived, unshared profile snapshots are deleted.
Archives use the profile's secure file writer and are limited to 64 MiB. An archive failure keeps
the active session and permits ordinary saves; a failed database commit restores the partition.

The database retains the archive filename and a fence against late session or PTY writes. This
small record survives restart; the old buffers no longer participate in routine session writes.
A delayed save with newer dirty editor text produces a content-addressed `late-editor-draft`
archive. Identical buffers share one file; they never recreate an active session partition.
Keep the archive directory when copying a profile. Database-only backups and exports do not
include these separate files. Archives are retained until explicitly recovered or removed.

To recover text from a removed host, preserve the archive, identify the recorded workspace and
path in `session.openFilesByWorktree`, and recover its `dirtyDraftContent` on the intended owner.
Do not restore PTY bindings or silently save the text through the currently focused host. Re-pairing
creates a new host ID; the archive preserves the previous identity rather than guessing a new one.

Startup cleanup handles absent paired-host UUIDs only with a readable, nonempty registry and no
current namespace custody. Missing, corrupt, unsupported, or empty registries preserve historical
state. An explicitly observed removal can retire the last host through the GUI or transport watch.
