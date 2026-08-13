# Graphify

This file is a discovery stub, not the usage guide. The full workflow pins both Python APIs and
CLI execution to `graphifyy==0.9.32`; never mix it with a bare PATH `graphify` command.

Engage Graphify for any question about a codebase, its architecture, file relationships,
or project content — especially when `graphify-out/` exists, in which case treat the
question as a Graphify query first. Graphify turns any input (code, docs, papers, images,
videos) into a persistent knowledge graph with god nodes, community detection, and
query/path/explain tools. It is invoked as the slash command `/graphify` with subcommands
such as `query`, `path`, `explain`, and `add`, and flags such as `--mode deep`, `--update`,
`--watch`, `--wiki`, `--mcp`, and `--neo4j`.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `orca-ide`. Never run bare
  `orca` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the user's machine.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

## Load the full guide before using Graphify

```text
ORCA skills get graphify
```

That prints the complete guide bundled with the running Orca binary — building and querying
the graph, `--mode deep`, `--update`/`--watch`, `--wiki`, `--mcp`, and `--neo4j`. Follow its
project-local Graphify 0.9.32 interpreter for all package and CLI operations.

Don't guess subcommands or flags from memory or from a cached copy of this stub. They
change between Orca releases, and this file deliberately no longer lists them.

## If an older Orca does not recognize `skills get`

Use this fallback only when the selected binary explicitly reports that `skills get` is an
unknown command. Another failure is not proof of an older binary; report it rather than
guessing or changing executables. For a confirmed pre-guide binary, use only this bounded,
read-only bootstrap to orient. Do not dead-end and do not invent commands:

```text
ORCA status --json
```

Graphify itself runs as a standalone `graphify` CLI, not through `ORCA` subcommands, so there
is no further Orca-mediated read-only surface to fall back on. If `graphify-out/graph.json`
already exists in the current directory, read `graphify-out/GRAPH_REPORT.md` directly for
orientation instead of guessing at commands.

Then tell the user that updating Orca restores the full bundled guide via
`ORCA skills get graphify`. Beyond these commands, ask the user rather than guessing a command
surface this older binary may not support.
