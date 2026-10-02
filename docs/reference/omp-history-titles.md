# OMP history titles

The message-graph scanner uses persisted OMP names ahead of the first user prompt:
`session.title`, version-1 `title` slots, `title_change.title`, and legacy
`session_info.name`. Empty or unsupported metadata leaves the previous name or
prompt fallback intact. Non-OMP graph parsing keeps its existing title policy.

Explicit user names outrank automatic names. Within the same source, timestamps
prevent the current first-line title slot from being replaced by older rename
entries later in the file. Newer appended renames still update the row. Legacy
records without timestamps retain file-order handling.

The graph fold stores title authority alongside the existing accumulator. Clones
retain it without sharing mutable accumulator or preview state, while preserving
the existing identity and message-consumer contracts. Cached append parsing uses
the normal durable offset; no extra scan, process, poll or watcher is introduced.

The parser is shared by local and remote content readers and uses transcript data
from the execution host. It performs no client-side path lookup and changes no
wire shape. Folder workspaces require no git metadata.

Run actual persistence and cache validation with a read-only OMP checkout:

```sh
ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-history-title-smoke.mjs /path/to/oh-my-pi
```

The smoke persists a first prompt, performs a real OMP user rename, and verifies
both cold and incrementally cached scans. It checks one full parse, one append
parse and identical-object reuse on an unchanged scan. All home/config/data roots
are disposable; no model requests are made.

This is the OMP subset of the history-name behavior proposed in PR #15696 by
Brennan Benson. Pi naming and title changes in the terminal are separate concerns.
